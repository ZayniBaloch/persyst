import * as ONNX_NODE from 'onnxruntime-node';
import * as ONNX_WEB from 'onnxruntime-web/webgpu';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const onnxWebPath = require.resolve('onnxruntime-web');
const wasmDir = path.dirname(onnxWebPath);

ONNX_NODE.InferenceSession.create = ONNX_WEB.InferenceSession.create;

const originalCreateObjectURL = URL.createObjectURL;
const patchedCreateObjectURL = (blob) => {
  const type = blob.type || '';
  if (type.includes('javascript') || type.includes('mjs')) {
    const filePath = path.join(wasmDir, 'ort-wasm-simd-threaded.asyncify.mjs');
    return pathToFileURL(filePath).href;
  }
  return originalCreateObjectURL(blob);
};
URL.createObjectURL = patchedCreateObjectURL;

function readLocalFile(filePath, urlStr) {
  const normalized = path.normalize(filePath);
  const buffer = fs.readFileSync(normalized);
  let contentType = 'application/octet-stream';
  if (normalized.endsWith('.wasm')) contentType = 'application/wasm';
  else if (normalized.endsWith('.mjs') || normalized.endsWith('.js')) contentType = 'text/javascript';
  else if (normalized.endsWith('.onnx') || normalized.endsWith('.ort')) contentType = 'application/octet-stream';
  return new Response(buffer, {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': contentType }
  });
}

const originalFetch = globalThis.fetch;
const patchedFetch = async (url, options) => {
  const urlStr = typeof url === 'string' ? url : url.url;

  // onnxruntime-web WASM binaries — resolve from node_modules
  if (urlStr.includes('onnxruntime-web') || urlStr.includes('ort-wasm')) {
    const filename = urlStr.split('/').pop().split('?')[0].split('#')[0];
    return readLocalFile(path.join(wasmDir, filename), urlStr);
  }

  // file:// URLs — Node.js fetch does not support them natively
  if (urlStr.startsWith('file://')) {
    return readLocalFile(fileURLToPath(urlStr), urlStr);
  }

  // fallback for any non-http/https/data URL (onnxruntime internal schemes, bare paths)
  if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://') && !urlStr.startsWith('data:')) {
    try {
      return readLocalFile(urlStr, urlStr);
    } catch (e) {
      throw e;
    }
  }

  return originalFetch(url, options);
};
globalThis.fetch = patchedFetch;
