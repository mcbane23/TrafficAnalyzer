import { parentPort } from 'node:worker_threads';
import { AnalysisWorkerHost, AnalysisWorkerRequest } from './analysisWorkerPool';

// Entry point of one AnalysisWorkerPool worker thread: hands each message to
// an AnalysisWorkerHost and posts its reply back.
const port = parentPort;
if (!port) throw new Error('analysisWorker must run as a worker thread');

const host = new AnalysisWorkerHost();
port.on('message', (request: AnalysisWorkerRequest) => {
  void host.handle(request).then((reply) => {
    if (reply) port.postMessage(reply);
  });
});
