import { createServer } from 'node:http';

const host = process.env.HOST;
const port = Number(process.env.PORT);
if (!host || !Number.isInteger(port)) throw new Error('Forgeboard did not provide HOST and PORT.');

const server = createServer((request, response) => {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`<!doctype html>
    <html>
      <head><title>Forgeboard local preview</title></head>
      <body>
        <h1>Preview server is ready</h1>
        <p data-testid="request-path">${request.url ?? '/'}</p>
      </body>
    </html>`);
});

server.listen(port, host, () => process.stdout.write(`preview-ready http://${host}:${port}\n`));

const close = () => server.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
