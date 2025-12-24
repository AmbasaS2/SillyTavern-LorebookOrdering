[Link zu ST Memory Books (STMB)](https://github.com/aikohanasaki/SillyTavern-MemoryBooks) | [Link zu ST Lorebook Ordering (STLO)](https://github.com/aikohanasaki/SillyTavern-LorebookOrdering)

# 🧠 Der ultimative Gedächtnis-Guide: STMB + STLO

ST Memory Books (STMB) ist essenziell für das **Generieren von Gedächtnisinhalten**, und ST Lorebook Ordering (STLO) ist essenziell, um zu **garantieren, dass dieser Inhalt tatsächlich verwendet wird**. Wenn sie zusammen eingesetzt werden, lösen sie das Kernproblem des **Gedächtnisausschlusses** (Memory Exclusion).

## Schritt 1: Die Bühne bereiten (Das Fundament)

**Erzwinge "Sorted Evenly" (Gleichmäßig sortiert):** Du musst zuerst sicherstellen, dass die Standard-World-Info-Einrichtung (WI) von SillyTavern so konfiguriert ist, dass STLO die Kontrolle übernehmen kann. In deinen SillyTavern **World Info Settings**, setze die **World Info Insertion Strategy** auf **"Sorted Evenly."** STLO benötigt diese Strategie, um die starre Kategoriesortierung des SillyTavern-Basiscodes (Chat  Persona  etc.) zu umgehen.

## Schritt 2: Den Gedächtnisinhalt erstellen (STMBs Aufgabe)

Verwende STMB, um automatisch deine Langzeit-Erinnerungen zu erstellen.

1. **Auto-Summary aktivieren:** Gehe zum STMB-Panel (der Zauberstab 🪄) und schalte **Auto-Summary** auf ON. Stelle dein bevorzugtes Intervall ein (z. B. **30 Nachrichten**).
2. **Memory Book binden/erstellen:** Stelle sicher, dass dein Chat ein dediziertes Lorebook für Erinnerungen hat. STMB platziert Erinnerungen normalerweise in einem Buch vom Typ "Global", verwendet aber der Einfachheit halber oft das an den Chat gebundene Lorebook.
3. **Ganz normal chatten:** Während dein Chat fortschreitet, generiert STMB automatisch dichte, hochwertige und strukturierte Zusammenfassungen. Diese Erinnerungen sind nun die "Passagiere", die versuchen, auf den begrenzten Kontext-"Flug" der KI zu gelangen.

## Schritt 3: Die Priorität garantieren (STLOs Aufgabe)

Dies ist der wichtigste Schritt. Du musst STLO verwenden, um die Priorität deines **Chat-gebundenen STMB-Buches** manuell zu senken, während du deine **Charakter-Essentials** aufwertest.

### A. Die "Chat-First"-Falle durchbrechen

Standardmäßig erhält ein Chat-gebundenes Memory Book die **höchste Priorität** (Chat-First). Das birgt das Risiko, zu viel Kontextspeicher zu verbrauchen und andere Welt-, Charakter- und/oder Persona-Lorebooks auszusperren. Mit STLO kannst du dies beheben, indem du eine benutzerdefinierte, spezifische Prioritätsstufe zuweist.

### B. Der empfohlene Prioritäten-Stapel

Verwende STLO, um benutzerdefinierte Prioritäten für alle relevanten Lorebooks festzulegen:

### Priorität vs. Position verstehen

**Position** bestimmt, *wo* der Inhalt im Kontext erscheint (Char up, Char down, AN up/down, @D).
**Priorität** bestimmt den *Budgetschutz* - was erhalten bleibt, wenn die Kontextlimits erreicht sind.

Höhere Prioritätszahl = stärkerer Schutz vor Kürzung (Truncation). Priorität funktioniert **innerhalb jeder Position**, nicht über Positionen hinweg.

---

### Empfohlene STLO Prioritätseinstellungen

| Lorebook-/Speichertyp | Empfohlene Priorität | Begründung |
| --- | --- | --- |
| **Charakter-Essentials** (Persönlichkeit, Beschreibung, Kernmerkmale) | **Priorität 5** (Höchste) | **Maximaler Budgetschutz.** Die Informationen der Charakterkarte sind das Fundament der Identität und des Verhaltens des Bots. Dieser Inhalt darf niemals gekürzt werden, sonst bricht der Charakter komplett zusammen. Die Position wird typischerweise vom Bot-Ersteller festgelegt (Char/AN down oder @D). |
| **Welt-Lore** (Setting, Fraktionen, Orte, Regeln) | **Priorität 4** (Hoch, mit Budgetlimits) | **Hoher Schutz, aber kontrollierbar.** World-Building liefert essenziellen Kontext, damit der Bot richtig funktioniert. Sollte budgetiert/begrenzt werden, um Aufblähung zu verhindern, aber geschützt genug sein, damit Kerninformationen der Welt nicht verloren gehen. Wird bei Bedarf vor den Charakter-Essentials gekürzt. |
| **Persona** (Deine Identität) | **Priorität 2-3** (Mittel) | **Moderater Schutz.** Informationen zur Benutzeridentität sind wichtig für personalisierte Antworten, aber der Bot kann funktionieren, wenn einige Persona-Details gekürzt werden. Weniger kritisch als das Charakter- oder Weltfundament. |
| **Befehle/Allgemeine Anweisungen** | **Priorität 2-3** (Mittel) | **Moderater Schutz.** Allgemeine Verhaltensanweisungen und Formatierungsbefehle. Wichtig für die Antwortqualität, besonders wenn sie vom Bot-Ersteller bei @D platziert wurden, aber nicht so kritisch wie die Charakterintegrität. |
| **Erinnerungen** (STMB, abgerufene Ereignisse) | **Priorität 1** (Niedrigste, mit Budgetlimits) | **Minimaler Schutz, aggressive Budgetierung.** Erinnerungen sollten typischerweise bei "Char up" (früh im Kontext) positioniert werden und eher als Bereicherung denn als essenzielle Information dienen. Wenn viele Erinnerungen ausgelöst werden, können die meisten sicher gekürzt werden, ohne den Bot zu zerstören. Budgetlimits verhindern, dass Gedächtnis-Bloat kritische Informationen verdrängt. |

---

### Kernprinzipien

1. **Schütze das Unersetzliche**: Charakter-Essentials können nicht rekonstruiert werden, wenn sie verloren gehen.
2. **Budgetiere, was aufblähen kann**: Welt-Lore und Erinnerungen können Dutzende von Einträgen auslösen – limitiere sie.
3. **Position ist separat**: Ein Element mit Priorität 1 bei @D erscheint immer noch ganz unten; es wird nur als Erstes gekürzt, wenn der Kontext voll ist.
4. **Vertraue dem Bot-Ersteller**: Gut gemachte Bots platzieren ihre kritischsten Anweisungen bei @D, unabhängig von deinen Prioritätseinstellungen.

---

## C. Eine Budget-Obergrenze setzen

* **Charakter-Essentials**: Kein Limit (meistens ohnehin kompakt)
* **Welt-Lore**: 15.000–25.000 Token max
* **Persona**: Kein Limit (meistens kompakt)
* **Befehle/Allgemeines**: Kein Limit (meistens kompakt)
* **Erinnerungen**: 5.000–15.000 Token max (aggressives Trimmen)

1. Öffne die STLO-Konfiguration für dein STMB-Lorebook.
2. Setze eine **Budget**-Obergrenze (z. B. **Feste Token** wie `5000` oder **Prozentsatz des Kontexts** wie `15%`).
3. Dies garantiert, dass sich das Lorebook, selbst wenn es früh verarbeitet wird, automatisch **selbst trimmt**, um deine Kapazitätsgrenze einzuhalten, und so Platz für alle anderen Lorebooks der Prioritäten 3, 2 und 1 lässt.

