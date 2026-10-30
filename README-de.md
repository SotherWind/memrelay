<h1 align="center">MemRelay</h1>

<p align="center">
  <a href="README-en.md">English</a> ·
  <strong>Deutsch</strong> ·
  <a href="README-es.md">Español</a> ·
  <a href="README-fr.md">Français</a> ·
  <a href="README-ja.md">日本語</a> ·
  <a href="README-ko.md">한국어</a> ·
  <a href="README-fa.md">فارسی</a> ·
  <a href="README-pt-BR.md">Português</a> ·
  <a href="README-id.md">Bahasa Indonesia</a> ·
  <a href="README.md">简体中文</a> ·
  <a href="README-zh-Hant.md">繁體中文</a>
</p>

<p align="center">
  <strong>Aufgaben-Handoff zwischen KI-Coding-Tools.</strong><br>
  In Codex zur Hälfte fertig, aber das Kontingent ist aufgebraucht? Wechsle zu Claude Code und sage einfach
  „Setze Aufgabe XX fort“ — es macht dort weiter, wo du aufgehört hast,
  ohne Anforderungen oder Fortschritt erneut zu beschreiben.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.15-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22.15">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="macOS | Linux | Windows">
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#schnellstart">Schnellstart</a> ·
  <a href="#highlights">Highlights</a> ·
  <a href="#befehle">Befehle</a> ·
  <a href="#unterstützte-quellen">Unterstützte Quellen</a> ·
  <a href="#bekannte-grenzen">Bekannte Grenzen</a> ·
  <a href="#web-ui">Web-UI</a> ·
  <a href="#entwicklung">Entwicklung</a>
</p>

## Warum MemRelay

Ein KI-Tool zu wechseln sollte keinen Fortschritt kosten.

Du bist in Codex zur Hälfte fertig, als das Kontingent aufgebraucht ist. Du willst in Claude Code weitermachen — aber es weiß nicht, was gerade passiert ist. Also erklärst du die Anforderungen erneut, beschreibst den Fortschritt noch einmal — oder gibst einfach auf.

MemRelay liest die Sitzungsprotokolle, die jedes Tool lokal auf deinem Rechner ablegt, und destilliert beim Wort „weiter“ direkt den Übergabeinhalt. **Das alte Tool muss nichts tun — keine Übergabedokumente, kein Copy-and-paste.**

## Highlights

- **Keine Mithilfe des alten Agents** — das alte Tool muss nichts tun; MemRelay liest sein lokales Sitzungsprotokoll und destilliert Fortschritt, offene Punkte und nächste Schritte.
- **Einmal einrichten, dann einfach sprechen** — nach `memrelay setup` musst du memrelay nie erwähnen; in Tools mit Skill oder Start-Hinweis wird „Setze Aufgabe XX fort“ automatisch ausgelöst.
- **Fortschritt bleibt aktuell** — mit deiner Zustimmung wird es in die Hooks der Tools installiert; Fortschritt landet nahezu in Echtzeit im lokalen Index, das nächste Tool kann sofort übernehmen.
- **Die gängigen Tools abgedeckt** — liest Sitzungen von Claude Code, Qoder, Codex, Cursor, CodeBuddy, WorkBuddy, OpenCode, ZCode, Trae und DeepSeek Harness (Trae und CodeBuddy in CLI- und IDE-Format).
- **Kein LLM nötig** — Übergabeinhalte werden lokal nach Regeln destilliert; standardmäßig offline, kein API-Key nötig; semantische Vektorsuche, Sitzungszusammenfassungen und Präferenzen-Aufräumen sind optionale Opt-in-Erweiterungen (siehe unten).
- **Lokal zuerst, rückgängig machbar** — Daten bleiben in `~/.memrelay/`, keine Telemetrie; andere Tools werden nur gelesen, jeder Schreibvorgang ist in einem Manifest erfasst und lässt sich rückgängig machen.

## Installation

Benötigt Node.js ≥ 22.15 (nvm / fnm / volta / mise funktionieren alle — der Launcher findet selbst ein passendes Node):

```bash
npm i -g memrelay    # globale Installation mit pnpm / yarn / bun funktioniert ebenfalls
memrelay setup
```

`setup` wird: **erkennen**, welche Tools installiert sind → **auflisten**, welche Dateien geschrieben werden (Start-Hinweise + Echtzeit-Index) → **einmal bestätigen** → schreiben → in jedem Terminal selbst testen.

> [!NOTE]
> Willst du es erst ohne Spuren ausprobieren? `memrelay setup --undo` macht alle Schreibvorgänge rückgängig (Daten bleiben erhalten); mit `--purge` werden auch die Daten gelöscht.

## Schnellstart

```bash
npm i -g memrelay && memrelay setup
```

Öffne dann ein Projekt, das du „mit einem anderen Tool halb fertig“ gemacht hast, und sage in einem integrierten Tool mit Skill oder Start-Hinweis:

> Setze Aufgabe XX fort

Der Agent führt automatisch `memrelay resume` aus, erhält die Übergabe (welches Tool, wie weit, was als Nächstes) und macht weiter.

## Befehle

Vom Agenten automatisch ausgeführt (nur lesend, nur ausgebend):

| Befehl | Wirkung |
|---|---|
| `memrelay resume "Stichwort"` | Findet die unterbrochene Aufgabe und gibt die Übergabe aus; werkzeugübergreifende Relay-Ketten werden mitgeliefert |
| `memrelay resume` | Ohne Stichwort: nimmt die zuletzt unterbrochene Aufgabe im aktuellen Projekt |
| `memrelay resume <Sitzungs-ID>` | Setzt genau diese Sitzung fort, nachdem sie im Menü gewählt wurde; die Ausgabe trägt die Relay-Markierung, damit die neue Sitzung in die Kette aufgenommen wird |
| `memrelay search "Stichwort"` | Durchsucht Sitzungen im aktuellen Projekt (CJK-Text ist durchsuchbar) |
| `memrelay show <Sitzungs-ID> --from N` | Blättert durch die Rohaufzeichnungen einer Sitzung |

Von dir ausgeführt:

| Befehl | Wirkung |
|---|---|
| `memrelay doctor` | Selbsttest + Aufbau/inkrementelle Aktualisierung des Sitzungsindex (`~/.memrelay/memrelay.db`) |
| `memrelay ui` | Lokale Web-UI (siehe unten) |
| `memrelay embed [--status]` | Vektor-Backfill: bettet Nachrichtentext ein und speichert ihn lokal (semantische Suche zuerst in den Einstellungen aktivieren); `--status` zeigt den Fortschritt |
| `memrelay summarize [--status]` | Sitzungszusammenfassungen: verdichtet den Sitzungsschluss über den Zusammenfassungs-Endpunkt zu 2–4 Sätzen Fortschritt; `--status` zeigt den Fortschritt |
| `memrelay tidy [--status\|--apply\|--undo]` | Werkzeugübergreifende Präferenzen: importiert globale Erinnerungen/Regeln jedes Tools, führt sie zusammen und schreibt einen MemRelay-Markerblock zurück |
| `memrelay setup --undo` | Integration rückgängig machen (Daten bleiben); mit `--purge` auch Daten löschen |

## Unterstützte Quellen

Sitzungen werden direkt gelesen — das Quell-Tool muss nichts tun:

| Tool | Wo seine Sitzungen liegen |
|---|---|
| Claude Code | `~/.claude/projects/<encoded-path>/*.jsonl` |
| Qoder | `~/.qoder/projects/<encoded-path>/*.jsonl` (inkl. IDE-Transcript-Format) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` (Metadaten aus schreibgeschützter `state_*.sqlite`) |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (Klartext-KV, schreibgeschützt) |
| CodeBuddy | CLI: `~/.codebuddy/projects/…/*.jsonl`; IDE: `%LOCALAPPDATA%/CodeBuddyExtension/Data/…/CodeBuddyIDE/…/history/<Workspace-md5>/<Sitzung>` (eine JSON-Datei pro Nachricht) |
| WorkBuddy | `~/.workbuddy/projects/…/*.jsonl` + `workbuddy.db`-Metadaten |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| Trae / Trae CN | CLI nutzt ein Codex-kompatibles Format; der Sitzungsspeicher der IDE ist verschlüsselt und wird aus Hook-Events rekonstruiert |
| DeepSeek Harness | `~/.dsh/sessions/<encoded-project-dir>/session-<id>/session.v4.jsonl.zstd` (mehrteiliges zstd, schreibgeschützt) |

> [!NOTE]
> Die Pfade folgen dem Standard-Datenverzeichnis der jeweiligen Plattform: Cursor / CodeBuddy stehen oben als Windows-Pfade; unter macOS sind es `~/Library/Application Support/…`, unter Linux `~/.config/…`. OpenCode nutzt auf allen Plattformen `~/.local/share/opencode`, und `~` ist das Home-Verzeichnis des aktuellen Benutzers.

Die Integration hat zwei Ebenen, alles per Manifest erfasst und rückgängig machbar: **Skill** (bringt einem Tool bei, bei „weiter“ memrelay aufzurufen) wird in die Skill-Verzeichnisse von Claude Code / Qoder / Codex / Cursor / CodeBuddy / WorkBuddy / Trae / Trae CN / DeepSeek Harness installiert; **Echtzeit-Indexierung** (Fortschritt landet sekundenschnell im Index) läuft in Claude Code / Qoder / Codex / CodeBuddy / WorkBuddy / ZCode / Trae CN (Hooks-Trio; CodeBuddy CLI und IDE teilen dieselben benutzerseitigen Einstellungen) sowie OpenCode / DeepSeek Harness über ihre offiziellen Plugin-Mechanismen — dsh nutzt für die Echtzeit-Indexierung ein In-Process-Plugin (umgeht die Prozessbeschränkungen seiner Sandbox) und installiert zusätzlich eine offizielle Hook-Kompatibilitätsbrücke für Start-Hinweise und Kompatibilität.

## Bekannte Grenzen

- **Automatisches Auslösen braucht Skill oder Start-Hinweis**: OpenCode hat derzeit nur das Echtzeit-Index-Plugin und keinen Start-Hinweis; dort muss `memrelay resume` manuell ausgeführt werden.
- **Der Sitzungsspeicher von Trae IDE ist verschlüsselt**: Er wird nur aus Hook-Events rekonstruiert, wenn die Echtzeit-Indexierung aktiv ist; mit nur dem Skill und ohne Echtzeit-Indexierung lassen sich vergangene Sitzungen nicht lesen.
- **Nur lokale Sitzungen**: keine Synchronisierung zwischen Rechnern; nicht unterstützte Tools oder verschlüsselte Sitzungen ohne Event-Stream können nicht gelesen werden.

## Web-UI

```bash
memrelay ui
```

Öffnet eine lokale Oberfläche, die nur auf `127.0.0.1` lauscht (einmaliges Token; Daten verlassen deinen Rechner nicht). Standardmäßig fester Port `4823` (bei Belegung zufällig); Theme und Sprache werden im Browser-localStorage gespeichert und beim nächsten Start wiederhergestellt.

- **Dashboard**: Statusübersicht, übergabebereite Aufgaben, letzte Aufgaben, 14-Tage-Aktivität und Verteilung nach Tool/Ordner
- **Aufgabenliste**: Relay-Ketten über Tools hinweg werden zu einer Aufgabe zusammengefasst, nach Ordner gruppiert, nach letzter Aktivität sortiert, Status live aktualisiert
- **Aufgabendetail**: vertikale Relay-Schiene + Übergabevorschau + Ein-Klick-Kopieren des Übergabe-Prompts
- **Drei Skins**: schlicht / Comic / Pixel × hell / dunkel / System; Theme- und Sprachwahl werden gemerkt
- **11 UI-Sprachen**: Vereinfachtes Chinesisch / English / Traditionelles Chinesisch / 日本語 / 한국어 / Español / Français / Deutsch / فارسی / Português (BR) / Bahasa Indonesia
- **Sitzungsbrowser & Suche**: Volltextsuche (inkl. CJK), Sprung zur Fundstelle mit Hervorhebung
- **Integrationen / Datenschutz-Ausschlüsse / Papierkorb / manuelle Korrekturen** (umbenennen, als erledigt markieren, Ketten teilen und zusammenführen)

## Optionale Erweiterungen

Semantische Suche, Sitzungszusammenfassungen und Präferenzen-Aufräumen sind standardmäßig aus. Jede Funktion hat eigene Endpunkt-Einstellungen in `memrelay ui` (unabhängig voneinander, können auf verschiedene Upstreams zeigen). Vor dem Senden werden Schlüssel redigiert; bei Fehlern fallen semantische Suche und Zusammenfassungen auf die bestehende regelbasierte Destillation zurück, beim Aufräumen wird nichts zurückgeschrieben.

- **Semantische Suche**: ergänzt einen semantischen Kanal, sodass die Suche nach „Login-Seite“ auch Sitzungen mit „auth page“ findet. Nur user/assistant-Text wird eingebettet, und nur OpenAI-kompatible Remote-`/embeddings` werden unterstützt. Größenordnung: ca. 250 Sitzungen ≈ 2 Mio. Zeichen ≈ 0,03 USD. Unveränderte Inhalte werden per Hash-Abgleich übersprungen; beim Modell-/Host-Wechsel gibt es einen Ein-Klick-Neuaufbau. [Design](docs/vector-search.md)
- **Sitzungszusammenfassungen**: erzeugt pro Sitzung eine 2–4-Sätze-Fortschrittszusammenfassung, angezeigt in der Resume-Ausgabe (`## 任务摘要（AI 生成）`), in Aufgabenliste und -detail sowie im Sitzungsbrowser. Material: Titel, Statussignale und die letzten ca. 20 Nachrichten des Sitzungsendes (≤8 KB); Reasoning und Tool-Ausgaben werden nicht gesendet. Ca. 1 Mio. Token für 250 Sitzungen. Unverändertes Material wird übersprungen; beim Modell-/Host-Wechsel gibt es einen Ein-Klick-Neuaufbau. [Design](docs/llm-summary.md)
- **Präferenzen aufräumen**: importiert die globalen Erinnerungen/Regeln jedes Tools schreibgeschützt, führt Duplikate und Widersprüche zusammen und schreibt einen MemRelay-Markerblock zurück. Es werden nur Markerblöcke angefasst, vor dem Schreiben wird ein Backup angelegt, alles ist rückgängig machbar, und Konflikte werden angezeigt statt automatisch entschieden; während `memrelay ui` läuft, werden Quelländerungen automatisch geprüft. [Design](docs/tidy.md)

Wartung: `memrelay embed` / `memrelay summarize` / `memrelay tidy` für einen vollständigen Nachlauf (unterbrechbar und fortsetzbar); `memrelay ui` füllt/prüft im Hintergrund, solange es läuft.

## Datenschutz & Sicherheit

- Daten liegen nur in `~/.memrelay/` auf deinem Rechner; keine Telemetrie; standardmäßig keine Cloud-Dienste.
- Die Dateien anderer Tools werden nur gelesen; geschrieben werden ausschließlich Skill-/Hook-Konfigurationen und `~/.memrelay/`, alles per Manifest erfasst und rückgängig machbar.
- Vor Indexierung und Ausgabe werden Schlüssel erkannt und maskiert (API-Keys, Tokens, private Schlüssel, Verbindungszeichenfolgen usw.).
- Wenn semantische Suche, Sitzungszusammenfassungen oder Präferenzen-Aufräumen aktiviert sind, werden relevante Texte/Erinnerungen (Schlüssel redigiert) an die von dir konfigurierten Hosts gesendet (jede Funktion hat ihren eigenen Endpunkt); standardmäßig sind alle drei aus.
- Der UI-Server lauscht nur auf `127.0.0.1`, verlangt ein Zugriffstoken und prüft den Host-Header; Schreibanfragen lehnen zusätzlich Cross-Origin-Origins ab.
- Trae-IDE-Hooks laufen in der Sandbox von Trae und können Roh-Events nur unter Traes `hooks_env` ablegen; gängige Schlüssel (`sk-`, GitHub-Tokens, AWS-Keys, `password/token`-Felder) werden in der Sandbox zuerst maskiert, Inhalte außerhalb dieser Regeln können jedoch in dieser Kopie verbleiben. Beim Rückgängigmachen der Integration werden diese Dateien gelöscht. Wem das wichtig ist, aktiviert nur den Trae-Skill und verzichtet auf die Echtzeit-Indexierung.

## Entwicklung

Das Repo ist ein pnpm-Workspace: `packages/cli` ist das CLI-Hauptpaket (das veröffentlichte Artefakt), `packages/ui` die Web-UI (Build landet in `dist/ui` des CLI).

```bash
pnpm install
pnpm typecheck     # tsc --noEmit für beide Pakete
pnpm test          # vitest Unit- + Integrationstests (E2E separat, siehe unten)
pnpm build         # erst tsdown → packages/cli/dist/cli.mjs, dann die UI nach packages/cli/dist/ui
cd packages/cli && npm link   # optional: memrelay in den PATH legen (entspricht npm i -g memrelay)
node packages/cli/test/e2e/bootstrap.mjs   # Launcher-Ende-zu-Ende
```

Design und Iterationspläne: [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE)
