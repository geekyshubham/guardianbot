import { ModelBridgeService } from "./service.js";

const service = await ModelBridgeService.create();
const server = service.createHttpServer();
await service.listen(server);
