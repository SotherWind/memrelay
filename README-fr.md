<h1 align="center">MemRelay</h1>

<p align="center">
  <a href="README-en.md">English</a> ·
  <a href="README-de.md">Deutsch</a> ·
  <a href="README-es.md">Español</a> ·
  <strong>Français</strong> ·
  <a href="README-ja.md">日本語</a> ·
  <a href="README-ko.md">한국어</a> ·
  <a href="README-fa.md">فارسی</a> ·
  <a href="README-pt-BR.md">Português</a> ·
  <a href="README-id.md">Bahasa Indonesia</a> ·
  <a href="README.md">简体中文</a> ·
  <a href="README-zh-Hant.md">繁體中文</a>
</p>

<p align="center">
  <strong>Relais de tâches entre outils de codage IA.</strong><br>
  À mi-chemin dans Codex quand le quota s'épuise ? Passez à Claude Code et dites simplement
  « continue la tâche XX » : il reprend là où vous en étiez,
  sans redécrire les besoins ni l'avancement.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.16-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22.16">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="macOS | Linux | Windows">
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#démarrage-rapide">Démarrage rapide</a> ·
  <a href="#points-forts">Points forts</a> ·
  <a href="#commandes">Commandes</a> ·
  <a href="#sources-prises-en-charge">Sources prises en charge</a> ·
  <a href="#limites-connues">Limites connues</a> ·
  <a href="#interface-web">Interface web</a> ·
  <a href="#développement">Développement</a>
</p>

## Pourquoi MemRelay

Changer d'outil IA ne devrait pas faire perdre le fil.

Vous êtes à mi-chemin dans Codex quand le quota s'épuise. Vous voulez continuer dans Claude Code, mais il ignore ce qui vient de se passer. Alors vous réexpliquez les besoins, vous redécrivez l'avancement — ou vous abandonnez.

MemRelay lit les journaux de session que chaque outil conserve en local et, au moment où vous dites « continue », il distille le contenu de passation sur place. **L'ancien outil n'a rien à faire : pas de document de passation, pas de copier-coller.**

## Points forts

- **Zéro coopération de l'ancien agent** — aucun prérequis pour l'ancien outil ; lecture directe de son journal de session local et distillation de l'avancement, des tâches restantes et des prochaines étapes.
- **Une seule installation, puis parlez normalement** — après `memrelay setup`, inutile de mentionner memrelay ; dans les outils dotés d'un Skill ou d'une indication de démarrage, « continue la tâche XX » le déclenche automatiquement.
- **L'avancement suit tout seul** — avec votre accord, il s'installe dans les hooks des outils ; l'avancement arrive dans l'index local en quasi-temps réel et l'outil suivant reprend immédiatement.
- **Les principaux outils couverts** — lit les sessions de Claude Code, Qoder, Codex, Cursor, CodeBuddy, WorkBuddy, OpenCode, ZCode, Trae et DeepSeek Harness (Trae et CodeBuddy en formats CLI et IDE).
- **Sans LLM** — la passation est distillée localement par règles ; hors ligne par défaut, sans clé API ; la recherche sémantique vectorielle, les résumés de session et l'organisation des préférences sont des améliorations optionnelles opt-in (voir ci-dessous).
- **Local d'abord, réversible** — les données restent dans `~/.memrelay/`, sans télémétrie ; les autres outils sont en lecture seule, chaque écriture est consignée dans un manifeste et annulable.

## Installation

Nécessite Node.js ≥ 22.16 (nvm / fnm / volta / mise conviennent — le lanceur trouve lui-même un Node valide) :

```bash
npm i -g memrelay    # l'installation globale avec pnpm / yarn / bun fonctionne aussi
memrelay setup
```

`setup` va : **détecter** les outils installés → **lister** les fichiers à écrire (indications de démarrage + indexation en temps réel) → **confirmer une fois** → écrire → s'auto-tester dans chaque terminal.

> [!NOTE]
> Envie d'essayer sans laisser de trace ? `memrelay setup --undo` annule tout ce qui a été écrit (données conservées) ; ajoutez `--purge` pour supprimer aussi les données.

## Démarrage rapide

```bash
npm i -g memrelay && memrelay setup
```

Ouvrez ensuite un projet « laissé à moitié fait avec un autre outil » et dites, dans un outil intégré doté d'un Skill ou d'une indication de démarrage :

> continue la tâche XX

L'agent lance automatiquement `memrelay resume`, récupère la passation (quel outil, où en était le travail, quelle est la suite) et continue.

## Commandes

Exécutées automatiquement par l'agent (lecture seule, affichage seul) :

| Commande | Effet |
|---|---|
| `memrelay resume "mot-clé"` | Trouve la tâche interrompue et affiche la passation ; les chaînes de relais entre outils sont incluses |
| `memrelay resume` | Sans mot-clé : reprend la tâche interrompue la plus récente du projet courant |
| `memrelay resume <id de session>` | Reprend exactement cette session après l'avoir choisie dans le menu ; la sortie porte le marqueur de relais pour que la nouvelle session rejoigne la chaîne |
| `memrelay search "mot-clé"` | Cherche dans les sessions du projet courant (le texte CJK est pris en charge) |
| `memrelay show <id de session> --from N` | Feuillette les enregistrements bruts d'une session |

Exécutées par vous :

| Commande | Effet |
|---|---|
| `memrelay doctor` | Auto-vérification + création/mise à jour incrémentale de l'index des sessions (`~/.memrelay/memrelay.db`) |
| `memrelay ui` | Interface web locale (voir ci-dessous) |
| `memrelay embed [--status]` | Remplissage vectoriel : embarque le texte et le stocke localement (activez d'abord la recherche sémantique dans les réglages) ; `--status` affiche la progression |
| `memrelay summarize [--status]` | Résumés de session : compresse la fin de chaque session en un résumé de progression de 2–4 phrases via l'endpoint de résumé ; `--status` affiche la progression |
| `memrelay tidy [--status\|--apply\|--undo]` | Organisation des préférences entre outils : importe la mémoire/règles globales de chaque outil, les fusionne et réécrit un bloc marqueur MemRelay |
| `memrelay setup --undo` | Annule l'intégration (données conservées) ; ajoutez `--purge` pour les supprimer aussi |

## Sources prises en charge

Les sessions sont lues directement — l'outil source n'a rien à faire :

| Outil | Où vivent ses sessions |
|---|---|
| Claude Code | `~/.claude/projects/<encoded-path>/*.jsonl` |
| Qoder | `~/.qoder/projects/<encoded-path>/*.jsonl` (y compris le format transcript de l'IDE) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` (métadonnées depuis `state_*.sqlite` en lecture seule) |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (KV en clair, lecture seule) |
| CodeBuddy | CLI : `~/.codebuddy/projects/…/*.jsonl` ; IDE : `%LOCALAPPDATA%/CodeBuddyExtension/Data/…/CodeBuddyIDE/…/history/<md5 de l'espace de travail>/<session>` (un fichier JSON par message) |
| WorkBuddy | `~/.workbuddy/projects/…/*.jsonl` + métadonnées `workbuddy.db` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| Trae / Trae CN | La CLI utilise un format compatible Codex ; le stockage de sessions de l'IDE est chiffré et reconstruit à partir des événements de hook |
| DeepSeek Harness | `~/.dsh/sessions/<encoded-project-dir>/session-<id>/session.v4.jsonl.zstd` (zstd multiframe, lecture seule) |

> [!NOTE]
> Les chemins suivent le répertoire de données par défaut de chaque plateforme : les lignes Cursor / CodeBuddy ci-dessus sont des chemins Windows ; sous macOS, utilisez `~/Library/Application Support/…`, sous Linux `~/.config/…`. OpenCode utilise `~/.local/share/opencode` sur toutes les plateformes, et `~` désigne le répertoire personnel de l'utilisateur courant.

L'intégration a deux couches, toutes consignées et annulables : **Skill** (apprend à un outil à appeler memrelay quand vous dites « continue ») est installé dans les répertoires de skills de Claude Code / Qoder / Codex / Cursor / CodeBuddy / WorkBuddy / Trae / Trae CN / DeepSeek Harness ; **l'indexation en temps réel** (l'avancement entre dans l'index en quelques secondes) est installée dans Claude Code / Qoder / Codex / CodeBuddy / WorkBuddy / ZCode / Trae CN (le trio de hooks ; la CLI et l'IDE de CodeBuddy partagent les mêmes réglages utilisateur) ainsi que dans OpenCode / DeepSeek Harness via leurs mécanismes officiels de plugins — dsh utilise un plugin in-process pour l'indexation en temps réel (contourne les restrictions de processus de son bac à sable) et installe en plus un pont officiel de compatibilité des hooks pour les indications de démarrage et la compatibilité.

## Limites connues

- **Le déclenchement automatique dépend d'un Skill ou d'une indication de démarrage** : OpenCode ne dispose actuellement que du plugin d'indexation en temps réel, sans indication de démarrage ; il faut donc y lancer `memrelay resume` manuellement.
- **Le stockage de sessions de l'IDE Trae est chiffré** : il n'est reconstruit à partir des événements de hook que lorsque l'indexation en temps réel est activée ; avec seulement le Skill et sans indexation en temps réel, ses sessions passées sont illisibles.
- **Sessions locales uniquement** : aucune synchronisation entre machines ; les outils non pris en charge, ou les sessions chiffrées sans flux d'événements, ne peuvent pas être lus.

## Interface web

```bash
memrelay ui
```

Ouvre une interface locale qui n'écoute que sur `127.0.0.1` (jeton à usage unique ; les données ne quittent pas votre machine). Port fixe `4823` par défaut (aléatoire s'il est occupé) ; le thème et la langue sont stockés dans le localStorage du navigateur et restaurés au prochain lancement.

- **Tableau de bord** : vue d'ensemble de l'état, tâches prêtes à reprendre, tâches récentes, activité des 14 derniers jours et répartition par outil/dossier
- **Liste des tâches** : les chaînes de relais entre outils deviennent une seule tâche ; regroupées par dossier et triées par activité récente, avec état en temps réel
- **Détail de tâche** : rail de relais vertical + aperçu de la passation + copie du prompt de passation en un clic
- **Trois skins** : minimal / bande dessinée / pixel × clair / sombre / système ; le thème et la langue sont mémorisés
- **11 langues d'interface** : chinois simplifié / English / chinois traditionnel / 日本語 / 한국어 / Español / Français / Deutsch / فارسی / português (BR) / bahasa indonésien
- **Navigation et recherche de sessions** : recherche plein texte (CJK incluse), saut vers la correspondance surlignée
- **Intégrations / exclusions de confidentialité / corbeille / corrections manuelles** (renommer, marquer comme terminée, scinder et fusionner des chaînes)

## Améliorations facultatives

La recherche sémantique, les résumés de session et l'organisation des préférences sont désactivés par défaut. Chaque fonction a ses propres réglages d'endpoint dans `memrelay ui` (indépendants, avec des upstreams possibles différents). Les clés sont expurgées avant envoi ; en cas d'échec, la recherche sémantique et les résumés reviennent à la distillation par règles existante, et l'organisation n'écrit rien.

- **Recherche sémantique** : ajoute un canal sémantique, si bien que chercher « page de connexion » trouve aussi les sessions qui disent « auth page ». Seul le texte user/assistant est embarqué, et seuls les `/embeddings` distants compatibles OpenAI sont pris en charge. Ordre de grandeur : ~250 sessions ≈ 2 M de caractères ≈ 0,03 USD. Le contenu inchangé est ignoré via une réconciliation par hash ; en cas de changement de modèle/hôte, une reconstruction en un clic est proposée. [Conception](docs/vector-search.md)
- **Résumés de session** : produit un résumé de progression de 2–4 phrases par session, affiché dans la sortie du relais (`## 任务摘要（AI 生成）`), la liste et le détail des tâches, et la navigation des sessions. La matière se limite au titre, aux signaux d'état et aux ~20 derniers messages de la fin de session (≤8 Ko) ; le raisonnement et les sorties d'outils ne sont pas envoyés. ~1 M de tokens pour 250 sessions. La matière inchangée est ignorée ; en cas de changement de modèle/hôte, une reconstruction en un clic est proposée. [Conception](docs/llm-summary.md)
- **Organisation des préférences** : importe en lecture seule la mémoire/règles globales de chaque outil, fusionne les doublons et contradictions, puis réécrit un bloc marqueur MemRelay. Elle ne touche qu'aux blocs marqueurs, sauvegarde avant écriture, est annulable et affiche les conflits au lieu de les trancher automatiquement ; les changements de sources sont vérifiés automatiquement pendant que `memrelay ui` tourne. [Conception](docs/tidy.md)

Maintenance : `memrelay embed` / `memrelay summarize` / `memrelay tidy` pour un remplissage complet (interruptible et reprenable) ; `memrelay ui` remplit/vérifie en arrière-plan pendant son exécution.

## Confidentialité et sécurité

- Les données ne vivent que dans `~/.memrelay/` sur votre machine ; aucune télémétrie ; aucun service cloud par défaut.
- Les fichiers des autres outils sont en lecture seule ; les écritures se limitent aux configurations de skills/hooks et à `~/.memrelay/`, toutes consignées dans un manifeste et annulables.
- Les clés (clés API, jetons, clés privées, chaînes de connexion) sont détectées et masquées avant l'indexation et l'affichage.
- Si vous activez la recherche sémantique, les résumés de session ou l'organisation des préférences, les textes/mémoires concernés (clés expurgées) sont envoyés aux hôtes que vous configurez (chaque fonction a son propre endpoint) ; les trois sont désactivés par défaut.
- Le serveur de l'interface n'écoute que sur `127.0.0.1`, exige un jeton d'accès et valide l'en-tête Host ; les requêtes d'écriture rejettent en plus les origines croisées.
- Les hooks de l'IDE Trae s'exécutent dans son bac à sable et ne peuvent déposer les événements bruts que dans `hooks_env` de Trae ; les clés courantes (`sk-`, jetons GitHub, clés AWS, champs `password/token`) sont masquées d'abord dans le bac à sable, mais le contenu hors de ces règles peut rester dans cette copie. Annuler l'intégration supprime ces fichiers. Si cela vous gêne, activez seulement le Skill Trae et non l'indexation en temps réel.

## Développement

Le dépôt est un workspace pnpm : `packages/cli` est le paquet CLI principal (l'artefact publié) et `packages/ui` l'interface web (le build est intégré dans `dist/ui` du CLI).

```bash
pnpm install
pnpm typecheck     # tsc --noEmit pour les deux paquets
pnpm test          # tests unitaires + d'intégration vitest (les e2e sont à part, voir plus bas)
pnpm build         # d'abord tsdown → packages/cli/dist/cli.mjs, puis l'interface dans packages/cli/dist/ui
cd packages/cli && npm link   # facultatif : mettre memrelay dans le PATH (équivaut à npm i -g memrelay)
node packages/cli/test/e2e/bootstrap.mjs   # bout en bout du lanceur
```

Conception et plans d'itération : [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE)
