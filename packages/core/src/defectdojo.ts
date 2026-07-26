export interface DefectDojoImport {
  scanType: string;
  engagement: number;
  fileName: string;
  contentType: string;
  report: Uint8Array;
  testTitle: string;
  tags: string[];
  closeOldFindings?: boolean;
}

export class DefectDojoClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string
  ) {}

  async reimport(input: DefectDojoImport): Promise<unknown> {
    const form = new FormData();
    form.set("scan_type", input.scanType);
    form.set("engagement", String(input.engagement));
    form.set("test_title", input.testTitle);
    form.set("close_old_findings", String(input.closeOldFindings ?? true));
    for (const tag of input.tags) form.append("tags", tag);
    form.set(
      "file",
      new Blob([input.report.slice().buffer as ArrayBuffer], { type: input.contentType }),
      input.fileName
    );
    const response = await fetch(new URL("/api/v2/reimport-scan/", this.baseUrl), {
      method: "POST",
      headers: { authorization: `Token ${this.apiToken}` },
      body: form
    });
    if (!response.ok) {
      throw new Error(`DefectDojo reimport returned ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }
}
