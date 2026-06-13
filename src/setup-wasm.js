import * as ONNX_NODE from 'onnxruntime-node';
import * as ONNX_WEB from 'onnxruntime-web/webgpu';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const onnxWebPath = require.resolve('onnxruntime-web');
const wasmDir = path.dirname(onnxWebPath);

// Redirect native Node session creation to WebAssembly session creation
ONNX_NODE.InferenceSession.create = ONNX_WEB.InferenceSession.create;

// Override URL.createObjectURL to return file URL of the existing local file
const originalCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob) => {
  const type = blob.type || '';
  if (type.includes('javascript') || type.includes('mjs')) {
    const filePath = path.join(wasmDir, 'ort-wasm-simd-threaded.asyncify.mjs');
    const fileUrl = pathToFileURL(filePath).href;
    return fileUrl;
  }
  return originalCreateObjectURL(blob);
};

// Override global fetch to load ONNX WASM binaries and model files from local disk
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const urlStr = typeof url === 'string' ? url : url.url;
  
  let isLocal = false;
  let filePath = '';
  
  if (urlStr.startsWith('file://')) {
    isLocal = true;
    filePath = fileURLToPath(urlStr);
  } else if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://') && !urlStr.startsWith('data:')) {
    isLocal = true;
    filePath = urlStr;
  }
  
  // Intercept onnxruntime-web CDN URLs and route them to node_modules/onnxruntime-web/dist
  if (urlStr.includes('onnxruntime-web') || urlStr.includes('ort-wasm')) {
    isLocal = true;
    const filename = urlStr.split('/').pop().split('?')[0].split('#')[0];
    filePath = path.join(wasmDir, filename);
  }
  
  if (isLocal) {
    filePath = path.normalize(filePath);
    try {
      const buffer = fs.readFileSync(filePath);
      let contentType = 'application/octet-stream';
      if (filePath.endsWith('.wasm')) contentType = 'application/wasm';
      else if (filePath.endsWith('.mjs') || filePath.endsWith('.js')) contentType = 'text/javascript';
      
      return new Response(buffer, {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': contentType }
      });
    } catch (err) {
      console.error('[persyst] Failed to read local file:', filePath, err.message);
      throw err;
    }
  }
  
  return originalFetch(url, options);
};
