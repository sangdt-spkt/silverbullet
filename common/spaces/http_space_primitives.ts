import { FileMeta } from "../types.ts";
import { FileData, FileEncoding, SpacePrimitives } from "./space_primitives.ts";
import {
  base64DecodeDataUrl,
  base64EncodedDataUrl,
} from "../../plugos/asset_bundle/base64.ts";
import { mime } from "../../plugos/deps.ts";
import { flushCachesAndUnregisterServiceWorker } from "../sw_util.ts";

export class HttpSpacePrimitives implements SpacePrimitives {
  constructor(
    readonly url: string,
    readonly expectedSpacePath?: string,
    readonly user?: string,
    readonly password?: string,
  ) {
  }

  public async authenticatedFetch(
    url: string,
    options: RequestInit,
  ): Promise<Response> {
    if (this.user && this.password) {
      // Explicitly set an auth cookie
      if (!options.headers) {
        options.headers = {};
      }
      (options.headers as Record<string, string>)["cookie"] = `auth=${
        btoa(`${this.user}:${this.password}`)
      }`;
    }
    const result = await fetch(url, options);
    if (result.status === 401 || result.redirected) {
      // Invalid credentials, reloading the browser should trigger authentication
      if (typeof location !== "undefined") {
        location.reload();
      }

      throw Error("Unauthorized");
    }
    return result;
  }

  async fetchFileList(): Promise<FileMeta[]> {
    const req = await this.authenticatedFetch(this.url, {
      method: "GET",
    });

    if (
      this.expectedSpacePath &&
      req.headers.get("X-Space-Path") !== this.expectedSpacePath
    ) {
      await flushCachesAndUnregisterServiceWorker();
      alert("Space folder path different on server, reloading the page");
      location.reload();
    }

    return req.json();
  }

  async readFile(
    name: string,
    encoding: FileEncoding,
  ): Promise<{ data: FileData; meta: FileMeta }> {
    const res = await this.authenticatedFetch(
      `${this.url}/${encodeURI(name)}`,
      {
        method: "GET",
      },
    );
    if (res.status === 404) {
      throw new Error(`Page not found`);
    }
    let data: FileData | null = null;
    switch (encoding) {
      case "arraybuffer":
        {
          data = await res.arrayBuffer();
        }
        break;
      case "dataurl":
        {
          data = base64EncodedDataUrl(
            mime.getType(name) || "application/octet-stream",
            new Uint8Array(await res.arrayBuffer()),
          );
        }
        break;
      case "utf8":
        data = await res.text();
        break;
    }
    return {
      data: data,
      meta: this.responseToMeta(name, res),
    };
  }

  async writeFile(
    name: string,
    encoding: FileEncoding,
    data: FileData,
    _selfUpdate?: boolean,
    lastModified?: number,
  ): Promise<FileMeta> {
    let body: any = null;

    switch (encoding) {
      case "arraybuffer":
        // actually we want an Uint8Array
        body = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        break;
      case "utf8":
        body = data;
        break;
      case "dataurl":
        data = base64DecodeDataUrl(data as string);
        break;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };
    if (lastModified) {
      headers["X-Last-Modified"] = "" + lastModified;
    }

    const res = await this.authenticatedFetch(
      `${this.url}/${encodeURI(name)}`,
      {
        method: "PUT",
        headers,
        body,
      },
    );
    const newMeta = this.responseToMeta(name, res);
    return newMeta;
  }

  async deleteFile(name: string): Promise<void> {
    const req = await this.authenticatedFetch(
      `${this.url}/${encodeURI(name)}`,
      {
        method: "DELETE",
      },
    );
    if (req.status !== 200) {
      throw Error(`Failed to delete file: ${req.statusText}`);
    }
  }

  async getFileMeta(name: string): Promise<FileMeta> {
    const res = await this.authenticatedFetch(
      `${this.url}/${encodeURI(name)}`,
      {
        method: "OPTIONS",
      },
    );
    if (res.status === 404) {
      throw new Error(`File not found`);
    }
    return this.responseToMeta(name, res);
  }

  private responseToMeta(name: string, res: Response): FileMeta {
    return {
      name,
      size: +res.headers.get("X-Content-Length")!,
      contentType: res.headers.get("Content-type")!,
      lastModified: +(res.headers.get("X-Last-Modified") || "0"),
      perm: (res.headers.get("X-Permission") as "rw" | "ro") || "rw",
    };
  }

  // Plugs are not supported
  proxySyscall(): Promise<any> {
    throw new Error("Not supported");
  }

  invokeFunction(): Promise<any> {
    throw new Error("Not supported");
  }
}
