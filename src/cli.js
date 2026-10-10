/**
 * Utilitaires en ligne de commande :
 *   node src/cli.js once   → génère un seul article (sans serveur) et affiche le résultat
 *   node src/cli.js serve  → sert le carrousel sans génération automatique
 */
import { createApp, listen, installShutdown, installProcessGuards } from "./app.js";

installProcessGuards();
const command = process.argv[2] ?? "once";

if (command === "once") {
  const app = await createApp({ withScheduler: false });
  const result = await app.pipeline.runOnce();
  if (result.status === "created") {
    const a = result.article;
    console.log(JSON.stringify({ status: "created", id: a.id, title: a.title, topic: a.topic.id, pmid: a.source.pmid, generator: a.generator, image: a.image.url }, null, 2));
    process.exit(0);
  }
  console.log(JSON.stringify({ status: result.status, reason: result.reason ?? result.error?.message }, null, 2));
  process.exit(result.status === "error" ? 1 : 0);
} else if (command === "serve") {
  const app = await createApp({ withScheduler: false });
  await listen(app);
  installShutdown(app);
} else {
  console.error(`Commande inconnue : ${command} (attendu : once | serve)`);
  process.exit(2);
}
