# OpenCode Token Monitor

> Übersetzung der englischen [README.md](README.md) (Version 0.1.0). Bei Abweichungen gilt die englische Fassung.

[English](README.md) · [中文](README.zh-CN.md)

Zeichnet Token-Verbrauch und Kosten jedes [OpenCode](https://opencode.ai)-LLM-Schritts in einer lokalen
SQLite-Datenbank auf. Mit der CLI `tokenmon` lässt sich das auswerten: nach Zeitraum, Projekt, Sitzung,
Modell, Agent, Befehl, Tool und Eltern-/Kind-Sitzungskette, dazu geschätzte Kontextzusammensetzung,
Cache-Nutzung, Trends, Vergleiche sowie Zusammenhänge mit Git und Konfiguration.

- **Exakte und geschätzte Werte bleiben getrennt.** Die Token-Zähler stammen aus OpenCodes eigener
  Abrechnung und lassen sich gegen OpenCodes Datenbank abgleichen. Die Kontextzusammensetzung ist eine
  Schätzung und wird so gekennzeichnet.
- **Kosten sind OpenCodes Listenpreis-Berechnung (USD), keine Anbieter-Rechnung.** Schritte ohne bekannten
  Preis werden als „nicht verfügbar“ angezeigt, nie als 0 $.
- **Nur lokal.** Kein Server, keine Netzwerkaufrufe, keine Prompt- oder Code-Inhalte gespeichert.

Stand: 0.1.0, getestet mit OpenCode 1.18.34 unter Linux x64. Siehe [Kompatibilität](docs/COMPATIBILITY.md)
und [Einschränkungen](#einschränkungen).

## Plugin installieren

Wählen Sie **eine** der beiden Varianten. Doppeltes Laden wird erkannt und ignoriert, sollte aber vermieden werden.

**Lokales Bundle (empfohlen):** die Release-Datei `opencode-token-monitor.js` in OpenCodes globales
Plugin-Verzeichnis kopieren:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
cp opencode-token-monitor.js "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/"
# oder mit installierter CLI:
tokenmon install-plugin            # überschreibt eine abweichende Datei nur mit --force (mit Backup)
```

**npm:** eine exakte Version in der eigenen `opencode.json` angeben (noch nicht in der Registry veröffentlicht):

```json
{ "plugin": ["opencode-token-monitor@0.1.0"] }
```

OpenCode neu starten. Sonst ist nichts zu konfigurieren; Token Monitor verändert Ihre `opencode.json` nie.

## CLI installieren

- Eigenständige Binärdatei aus dem Release (`tokenmon-linux-x64`, `tokenmon-linux-arm64`,
  `tokenmon-macos-x64`, `tokenmon-macos-arm64`, `tokenmon-windows-x64.exe`), ohne weitere Abhängigkeiten.
  Die macOS-/Windows-Binärdateien sind nicht signiert; Gatekeeper/SmartScreen fragen ggf. nach
  (`xattr -d com.apple.quarantine tokenmon-macos-*` unter macOS).
- npm: `npm install -g opencode-token-monitor` — benötigt **Node ≥ 22.13** (nutzt `node:sqlite`) oder Bun.

## Verwendung

```bash
tokenmon today                         # heutiger Verbrauch nach Modell (System-Zeitzone)
tokenmon week --tz Europe/Berlin       # Kalenderwoche, Beginn Montag
tokenmon summary --last 24h --group-by project,agent
tokenmon summary --from 2026-10-01 --to 2026-10-06    # --to als Datum schließt den ganzen Tag ein
tokenmon commands week                 # direct / descendant / inclusive je Befehl
tokenmon sessions                      # Wurzel-Sitzungen mit Verbrauch des ganzen Baums
tokenmon trace ses_xxx                 # Sitzungsbaum, Kind-Sitzungen, Tools, Befehle
tokenmon context --by-source           # geschätzte Prompt-Zusammensetzung vs. exakte Prompt-Tokens
tokenmon cache month
tokenmon trend --bucket week
tokenmon compare last-week week        # oder: tokenmon compare --by fingerprint
tokenmon live                          # laufend aktualisierte Ansicht für heute
tokenmon import                        # Nachfüllen/Abgleich aus OpenCodes eigener Datenbank
tokenmon doctor                        # Pfade, Schema, Plugin-Ladevorgänge, Probleme
```

Alle Befehle unterstützen `--json` (stabiler Vertrag, `schemaVersion` 1.0.0), die meisten `--csv`, alle
`--redact-paths`. Vollständige Referenz: [docs/CLI.md](docs/CLI.md).

## Speicherort der Daten

`$OPENCODE_TOKEN_MONITOR_DB`, sonst `$XDG_DATA_HOME/opencode-token-monitor/token-monitor.sqlite`, sonst
`~/.local/share/opencode-token-monitor/token-monitor.sqlite` (gleiche Regel auf allen Systemen, wie
OpenCodes eigenes Datenverzeichnis). Plugin und CLI verwenden dieselbe Pfadauflösung; `tokenmon doctor`
zeigt den verwendeten Pfad.

Jeder Rechner hat seine eigene Historie. Das Entfernen des Plugins löscht keine Daten. Historie explizit
löschen: `tokenmon data prune --before 2026-01-01`, `tokenmon data vacuum` oder `tokenmon data purge --yes`.

## Was gemessen wird

| Ausgabe | Genauigkeit | Quelle |
| --- | --- | --- |
| input / output / reasoning / cache read / cache write Tokens | exakt (wie von OpenCode gemeldet) | OpenCode-`step-finish`-Ereignisse; abgleichbar mit OpenCodes Datenbank |
| Kosten | OpenCode-Listenpreis, USD | OpenCodes Modellpreise; `n/a`, wenn kein Preis bekannt ist |
| Befehle, Kind-Sitzungen, Tools | exakte Verknüpfung, soweit beobachtet | OpenCode-Hooks; nicht verknüpfbare Einträge werden separat aufgeführt |
| Kontextzusammensetzung | Schätzung (Zeichen / 4) | System-Prompt, AGENTS.md, Skills, Tool-Definitionen, Gespräch, Tool-Ergebnisse |
| Git-Branch/Commit/Änderungsstatus, Konfigurations-Fingerprint | je Wurzel-Sitzung | `git` im Projekt; gesalzener Hash der Konfigurationsdateien |

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Ergebnisse aus Phase 0: [docs/API_SPIKE.md](docs/API_SPIKE.md).

## Datenschutz

Es werden keine Prompt-Texte, kein Code, keine Tool-Ein-/Ausgaben, Sitzungstitel oder Befehlsargumente
gespeichert — nur Zähler, Größen, IDs, Modellnamen und Pfade. Beim Teilen von Ausgaben `--redact-paths` verwenden.

## Einschränkungen

- OpenCode erfasst den Verbrauch der Sitzungstitel-Generierung nicht; Token Monitor meldet die Anzahl
  solcher Anfragen, kann ihre Tokens aber nicht zählen.
- Normale Befehle (ohne `subtask`) lassen sich per `import` nicht aus OpenCodes Datenbank rekonstruieren;
  nur das laufende Plugin sieht sie.
- Bisher nur mit OpenCode 1.18.34 unter Linux und einem OpenAI-kompatiblen Anbieter getestet; andere
  Anbieter, macOS und Windows sind noch nicht verifiziert.
- Lizenz: noch nicht festgelegt (`UNLICENSED`).

## Entwicklung

```bash
bun install
bun run check                     # Typprüfung + Unit-/Integrationstests + Build
node --test tests/node/cli.test.mjs
OPENCODE_BIN=opencode bun tests/e2e/run-e2e.ts   # echtes OpenCode + Mock-Anbieter
bun run build:binaries
```

Siehe [AGENTS.md](AGENTS.md), [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) und das
Integrationspaket für das Portable Profile unter [integrations/portable-profile](integrations/portable-profile/README.md).
