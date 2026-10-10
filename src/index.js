/** Point d'entrée : serveur du carrousel + génération automatique toutes les N minutes. */
import { createApp, listen, installShutdown, installProcessGuards } from "./app.js";

installProcessGuards();
const app = await createApp({ withScheduler: true });
await listen(app);
installShutdown(app);
app.scheduler.start();
