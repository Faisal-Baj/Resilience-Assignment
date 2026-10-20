// Starts the server. The app itself is built in app.js.
import { app } from './app.js';
import { config } from './config.js';

app.listen(config.port, () => {
  console.log(`Remediation Workspace running at ${config.appOrigin}`);
});
