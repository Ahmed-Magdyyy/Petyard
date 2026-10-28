import axios from "axios";
import { uploadBunnyObject, downloadBunnyObject } from "../../../shared/utils/bunnyStorage.js";

export function sourceObjectKey(row) {
  return `assistant-references/${row.sha256}/original.${row.format}`;
}

export function createReferenceStorage(config, { transport = axios } = {}) {
  const { zone, accessKey, endpoint, timeoutMs } = config.storage;
  const credentials = { zone, accessKey, endpoint, timeoutMs };
  return {
    put: (objectKey, buffer, contentType) => uploadBunnyObject({ ...credentials, objectKey, buffer, contentType, transport }),
    get: (objectKey, maxBytes) => downloadBunnyObject({ ...credentials, objectKey,
      transport: { request: request => transport.request({ ...request, maxContentLength: maxBytes }) } }),
  };
}
