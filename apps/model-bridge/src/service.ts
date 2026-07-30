import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  type DataClassification,
  type ReviewRequest,
  validateBackendCapabilities,
  validateReviewRequest
} from "@guardianbot/protocol";
import { createAdapter } from "./adapters/index.js";
import { buildRuntimeCapabilities, loadConfig, resolveRoutes } from "./config.js";
import { BridgeError, sanitizeError } from "./errors.js";
import { readJsonBody, sendJson } from "./http.js";
import type {
  AdapterContext,
  BridgeAdapter,
  LoadedConfig,
  ResolvedRoute
} from "./types.js";

interface RouteRuntime {
  route: ResolvedRoute;
  primary: BridgeAdapter;
  fallback?: BridgeAdapter;
}

const AUTH_REALM = 'Bearer realm="guardian-model-bridge"';

export class ModelBridgeService {
  private readonly config: LoadedConfig;
  private readonly routes: Map<string, RouteRuntime>;
  private readonly capabilities;

  private constructor(
    config: LoadedConfig,
    routes: Map<string, RouteRuntime>,
    capabilities: ReturnType<typeof validateBackendCapabilities>
  ) {
    this.config = config;
    this.routes = routes;
    this.capabilities = capabilities;
  }

  static async create(
    environment: NodeJS.ProcessEnv = process.env,
    contextOverrides: Partial<AdapterContext> = {}
  ): Promise<ModelBridgeService> {
    const config = loadConfig(environment);
    const routes = resolveRoutes(config);
    const adapterContext: AdapterContext = {
      responseBodyBytes: config.responseBodyBytes,
      startupProbeTimeoutMs: config.startupProbeTimeoutMs,
      ...contextOverrides
    };
    const runtimes = new Map<string, RouteRuntime>();
    for (const route of routes) {
      const primary = createAdapter(route.binding, adapterContext);
      const fallback = route.fallbackBinding
        ? createAdapter(route.fallbackBinding, adapterContext)
        : undefined;
      if (typeof primary.probe === "function") {
        await primary.probe({ route });
      }
      if (fallback && typeof fallback.probe === "function") {
        await fallback.probe({
          route: {
            ...route,
            binding: route.fallbackBinding!
          }
        });
      }
      runtimes.set(route.profile, { route, primary, fallback });
    }
    const capabilities = validateBackendCapabilities(buildRuntimeCapabilities(routes));
    return new ModelBridgeService(config, runtimes, capabilities);
  }

  createHttpServer(): Server {
    return createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.bindPort, this.config.bindHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        sendJson(response, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/capabilities") {
        if (!this.isAuthorized(request)) {
          this.sendUnauthorized(response);
          return;
        }
        sendJson(response, 200, this.capabilities);
        return;
      }
      if (request.method === "POST" && request.url === "/v1/reviews") {
        if (!this.isAuthorized(request)) {
          this.sendUnauthorized(response);
          return;
        }
        const body = await readJsonBody(request, this.config.requestBodyBytes);
        let reviewRequest: ReviewRequest;
        try {
          reviewRequest = validateReviewRequest(body);
        } catch (error) {
          if (error instanceof ProtocolValidationError) {
            throw new BridgeError("bad_request", error.message, 400, false);
          }
          throw error;
        }
        const routeRuntime = this.routes.get(reviewRequest.profile);
        if (!routeRuntime) {
          throw new BridgeError("unsupported_route", "route is not configured", 422, false);
        }
        this.assertBindingAllowsClassification(
          routeRuntime.route.binding.allowedClassifications,
          reviewRequest.repository.visibility
        );
        if (JSON.stringify(reviewRequest).length > routeRuntime.route.maxInputCharacters) {
          throw new BridgeError(
            "payload_too_large",
            "request exceeded route maxInputCharacters",
            413,
            false
          );
        }

        try {
          const primaryResult = await routeRuntime.primary.review({
            request: reviewRequest,
            route: routeRuntime.route
          });
          sendJson(response, 200, primaryResult.result);
          return;
        } catch (error) {
          const sanitized = sanitizeError(mapOutputValidationError(error));
          if (!routeRuntime.fallback || !sanitized.retryable) {
            throw sanitized;
          }
        }

        this.assertFallbackAllowed(routeRuntime.route, reviewRequest.repository.visibility);
        const fallbackBinding = routeRuntime.route.fallbackBinding;
        if (!fallbackBinding) {
          throw new BridgeError("unavailable", "fallback binding missing", 503, true);
        }
        const fallbackResult = await routeRuntime.fallback!.review({
          request: reviewRequest,
          route: {
            ...routeRuntime.route,
            binding: fallbackBinding
          }
        });
        sendJson(response, 200, fallbackResult.result);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const safe = sanitizeError(mapOutputValidationError(error));
      sendJson(response, safe.statusCode, {
        error: {
          code: safe.code,
          message: safe.message,
          retryable: safe.retryable
        }
      });
    }
  }

  private isAuthorized(request: IncomingMessage): boolean {
    if (!this.config.authRequired) return true;
    const expected = this.config.authToken;
    if (!expected) return false;
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string") return false;
    const match = authorization.match(/^Bearer (.+)$/i);
    if (!match) return false;
    return constantTimeTokenMatch(match[1] ?? "", expected);
  }

  private sendUnauthorized(response: ServerResponse): void {
    response.setHeader("www-authenticate", AUTH_REALM);
    sendJson(response, 401, {
      error: {
        code: "unauthorized",
        message: "Authentication required.",
        retryable: false
      }
    });
  }

  private assertBindingAllowsClassification(
    allowedClassifications: readonly string[],
    classification: DataClassification
  ): void {
    if (!allowedClassifications.includes(classification)) {
      throw new BridgeError(
        "unsupported_classification",
        "classification is not allowed",
        422,
        false
      );
    }
  }

  private assertFallbackAllowed(
    route: ResolvedRoute,
    classification: DataClassification
  ): void {
    const fallback = route.fallbackBinding;
    if (!fallback) {
      throw new BridgeError("unavailable", "fallback binding missing", 503, true);
    }
    this.assertBindingAllowsClassification(route.binding.allowedClassifications, classification);
    if (!fallback.allowedClassifications.includes(classification)) {
      throw new BridgeError(
        "unavailable",
        "fallback binding no longer allows the request classification",
        503,
        false
      );
    }
    for (const primaryClassification of route.binding.allowedClassifications) {
      if (!fallback.allowedClassifications.includes(primaryClassification)) {
        throw new BridgeError(
          "unavailable",
          "fallback binding is no longer permitted",
          503,
          false
        );
      }
    }
  }
}

// Adapter/fixture validateReviewResult failures are backend faults, not 400s.
function mapOutputValidationError(error: unknown): unknown {
  if (error instanceof ProtocolValidationError) {
    return new BridgeError(
      "invalid_output",
      "structured output failed schema validation",
      503,
      true
    );
  }
  return error;
}

function constantTimeTokenMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) {
    const maxLength = Math.max(actualBuffer.length, expectedBuffer.length);
    const paddedActual = Buffer.alloc(maxLength);
    const paddedExpected = Buffer.alloc(maxLength);
    actualBuffer.copy(paddedActual);
    expectedBuffer.copy(paddedExpected);
    timingSafeEqual(paddedActual, paddedExpected);
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
