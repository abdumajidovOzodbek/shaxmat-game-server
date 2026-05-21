import { buildServer } from "./server.js";
import { config } from "./config.js";

const server = buildServer();
server.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[game-server] listening on http://0.0.0.0:${config.port}`);
});
