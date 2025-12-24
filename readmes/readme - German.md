# 📚 Lorebook Ordering (Eine SillyTavern-Erweiterung)

Eine SillyTavern-Erweiterung, die Prioritätsmanagement auf Lorebook-Ebene und Budgetierung zu World Info hinzufügt. Ermöglicht die vollständige Kontrolle darüber, welche Lorebooks zuerst aktiviert werden, und erlaubt die Begrenzung von "hungrigen" Lorebooks. Perfekt für Nutzer mit mehreren Lorebooks, die eine feinkörnige Kontrolle über das Verhalten von World Info benötigen.

---

💡 **Willst du die volle Kraft des Speichermanagements freischalten?**
Nutze STLO zusammen mit [SillyTavern-MemoryBooks (STMB)](https://github.com/aikohanasaki/SillyTavern-MemoryBooks) für die besten Ergebnisse!  
Siehe den [STMB + STLO Guide](guides/STMB%20and%20STLO%20-%20English.md) für Einrichtungstipps und wie du sicherstellst, dass deine Erinnerungen korrekt priorisiert werden.

---

🌐 **Suchst du nach Dokumentation oder Anleitungen in einer anderen Sprache?**
Bitte überprüfe den Ordner [`/readmes/`](readmes/) für übersetzte Readmes und den Ordner [`/guides/`](guides/) für übersetzte Anleitungen in deiner Sprache!

🆕 **Unterstützt jetzt charakterspezifische Überschreibungen in Gruppenchats und präzise Reihenfolge-Anpassung!**

**📋 [Versionsverlauf & Changelog](CHANGELOG.md)**

## FAQ
Die Einstellungen sind über den Button "Lorebook Ordering" im World Info-Panel erreichbar (erscheint neben dem Suchfeld, wenn Lorebooks verfügbar sind).

![STLO Button](https://github.com/aikohanasaki/imagehost/blob/main/STLO.png)

F: Funktioniert es wirklich? Warum sehe ich alle Einträge in der World Info Info?
A: Ja, es funktioniert. Wenn du in die Konsole (F12) schaust, siehst du `[STLO] Trimmed WI entry` für jeden einzelnen Eintrag, der entfernt wurde.

---

## 📋 Voraussetzungen

- **SillyTavern:** 1.13.5+ (neueste Version empfohlen)
- **World Info Strategie:** MUSS die Einfügestrategie "evenly" verwenden, damit STLO funktioniert
- **Mehrere Lorebooks:** Die Erweiterung ist am nützlichsten, wenn du mehrere Lorebooks hast, die priorisiert werden müssen

## 💡 Empfohlene globale World Info/Lorebook Aktivierungseinstellungen
Getestet mit diesen Einstellungen:

- **Einfügestrategie (Insertion Strategy):** "evenly" (erforderlich für STLO)
- **Max Rekursionsschritte (Max Recursion Steps):** 2 (allgemeine Empfehlung)

---

## 🚀 Erste Schritte

### 1. **Installieren & Konfigurieren**
- Installiere die Erweiterung in deinem SillyTavern-Erweiterungsordner
- Stelle sicher, dass du mehrere Lorebooks verfügbar hast
- Setze die World Info Einfügestrategie in den SillyTavern-Einstellungen auf "evenly"

![Extension Button](https://github.com/aikohanasaki/imagehost/blob/main/settings.png)

### 2. **Einstellungen aufrufen**
- Öffne das World Info Panel in SillyTavern
- Suche nach dem "Lorebook Ordering"-Button neben dem Suchfeld
- Klicke darauf, um das Lorebook-Management-Fenster zu öffnen

### 3. **Prioritäten konfigurieren**
- Wähle ein Lorebook aus dem Dropdown-Menü
- Setze das Prioritätslevel (1=Niedrigste bis 5=Höchste, 3=Standard)
- Setze ein Budget (falls gewünscht)
- Konfiguriere bei Bedarf die Reihenfolge-Anpassung
- Speichere und wiederhole dies für andere Lorebooks

![Basic (global) settings](https://github.com/aikohanasaki/imagehost/blob/main/STLO%20basic.png)

---

## ⌨️ Slash-Befehl: /stlo

Öffne das STLO Prioritäts- & Budget-Fenster für ein spezifisches Lorebook direkt aus der Chat-Eingabe.

- Beschreibung: Springe schnell zu den STLO-Einstellungen für ein bestimmtes Lorebook
- Nutzung:

```

/stlo <Lorebook Name>

```
- Argument:
- Lorebook Name (Groß-/Kleinschreibung egal). Du kannst Namen mit Leerzeichen ohne Anführungszeichen eingeben; Anführungszeichen sind optional.
- Beispiele:
- `/stlo Mein Lorebook`
- `/stlo "Welt Wissen"`
- `/stlo Alice`

Was es tut:
- Wählt das passende Lorebook im World Info Editor aus
- Öffnet das ST Lorebook Ordering Fenster für dieses Lorebook

Hinweise:
- Erfordert eine existierende World Info Datei. Wenn keine ausgewählt/verfügbar ist, siehst du: "Create or select a World Info file first."
- Wenn der Name mit keinem Lorebook übereinstimmt, siehst du: "Lorebook not found: NAME"
- Wenn du den Lorebook-Namen weglässt, siehst du den Nutzungshinweis: "Usage: /stlo <lorebook name>"
- STLO benötigt weiterhin die "evenly" Einfügestrategie, damit Sortierung und Budgets wirksam werden

---

## 🎯 Prioritätsstufen

### **Prioritätssystem**
- **Höchste (5):** Lorebook-Einträge werden zuerst aktiviert und erhalten Vorrang bei der Budgetzuweisung
- **Hoch (4):** Höhere Priorität als Standard
- **Standard (3):** Normales SillyTavern-Verhalten (unverändert vom Original)
- **Niedrig (2):** Niedrigere Priorität als Standard
- **Niedrigste (1):** Lorebook-Einträge werden zuletzt aktiviert

### **Wie es funktioniert**
- Lorebooks mit höherer Priorität werden während der World Info Aktivierung zuerst verarbeitet
- Funktioniert nur mit der Einfügestrategie "evenly"

---

## 📊 System zur Anpassung der Reihenfolge (Order Adjustment)

### **Feinabstimmung jenseits der Priorität**
Das System zur Anpassung der Reihenfolge ermöglicht eine präzise Kontrolle über die Verarbeitungsreihenfolge von Lorebook-Einträgen innerhalb derselben Prioritätsstufe:

- **Anpassungsbereich:** -10.000 bis +10.000 Werte, die zu den Prioritätsberechnungen hinzugefügt werden
- **Präzise Kontrolle:** Feinabstimmung der Verarbeitungsreihenfolge ohne Änderung der Prioritätsstufen
- **Mathematische Formel:** `Endgültige Reihenfolge = Priorität × 10.000 + Reihenfolge-Anpassung + Ursprüngliche Eintrag-Reihenfolge`

### **Anwendungsbeispiel**

```

Lorebook A: Priorität 3, Reihenfolge-Anpassung +250
Lorebook B: Priorität 3, Reihenfolge-Anpassung -100
Lorebook C: Priorität 3, Reihenfolge-Anpassung 0 (Standard)

Endgültige Verarbeitungsreihenfolge:

1. Lorebook A: 30.250 + Eintrag-Reihenfolge (wird zuerst verarbeitet)
2. Lorebook C: 30.000 + Eintrag-Reihenfolge (Standard)
3. Lorebook B: 29.900 + Eintrag-Reihenfolge (wird zuletzt verarbeitet)

```

### **Gruppenchat-Steuerung**
- **Immer anwenden:** Reihenfolge-Anpassung funktioniert sowohl in Einzel- als auch in Gruppenchats (Standard)
- **Nur Gruppenchats:** Wähle diese Option, um die Anpassung nur während Gruppenchats anzuwenden
- **Charakter-Überschreibungen:** Setze unterschiedliche Reihenfolge-Anpassungen für bestimmte Charaktere in Gruppenchats

### **Wann man die Reihenfolge-Anpassung nutzt**
- **Charakter vs. Welt:** Bewerte charakterspezifische Lorebooks etwas höher als allgemeine Welt-Infos
- **Lore-Hierarchie:** Stelle sicher, dass kritische Lore vor ergänzenden Informationen verarbeitet wird
- **Speichermanagement:** Feinabstimmung, wann Erinnerungen/LTM-Einträge relativ zu anderen Inhalten aktiviert werden
- **Dialog-Prioritäten:** Steuere, wann dialogbezogene Lorebooks in Gesprächen aktiviert werden

---

## 🎭 Gruppenchat Charakter-Überschreibungen

![Group Chat Specific Settings](https://github.com/aikohanasaki/imagehost/blob/main/STLO%20group.png)

### **Pro-Charakter Anpassung**
In Gruppenchats können verschiedene Charaktere nun unterschiedliche Lorebook-Verhaltensweisen während ihrer individuellen Züge haben:

- **Charakterspezifische Prioritäten:** Alice könnte ein Lorebook mit Priorität 5 nutzen, während Bob dasselbe Lorebook mit Priorität 2 nutzt
- **Individuelle Reihenfolge-Anpassung:** Jeder Charakter kann eigene Anpassungswerte für dasselbe Lorebook haben
- **Nahtlose Integration:** Funktioniert automatisch während der Gruppenchat-Generierung - keine zusätzliche Einrichtung erforderlich

### **Wie Gruppenchat-Überschreibungen funktionieren**
1. **Überschreibung konfigurieren:** Erweitere in den Lorebook-Einstellungen den Abschnitt "Group Chat Overrides"
2. **Charaktere auswählen:** Wähle, welche Charaktere spezielle Einstellungen für dieses Lorebook erhalten
3. **Benutzerdefinierte Werte setzen:** Jeder Charakter kann einzigartige Prioritäts- und Reihenfolge-Einstellungen haben
4. **Automatische Anwendung:** Während des Gruppenchats nutzt Alice ihre Überschreibungseinstellungen, wenn sie an der Reihe ist; wenn Bob an der Reihe ist, nutzt er seine

### **Beispielszenarien**
- **Charakter-fokussiertes Lorebook:** Setze das persönliche Lorebook eines Charakters auf Priorität 5 für ihn, Priorität 1 für andere
- **Lore-Spezialisierung:** Ein Gelehrten-Charakter erhält hohe Priorität bei akademischen Lorebooks, ein Krieger niedrige Priorität
- **Reihenfolge-Feinabstimmung:** Stärke charakterspezifische Inhalte mit positiven Reihenfolge-Anpassungen

### **Wichtige Hinweise**
- **Einzelchat-Verhalten:** Charakter-Überschreibungen werden in Einzel-Chats ignoriert (nutzt Standard-Lorebook-Einstellungen)
- **Fallback-Logik:** Charaktere ohne spezifische Überschreibungen nutzen die Standardeinstellungen des Lorebooks
- **Keine Konflikte:** Der Wechsel von Gruppen- zu Einzelchat löscht automatisch den Überschreibungsstatus

---

## ⚙️ Einstellungen & Konfiguration

### **Pro-Lorebook Einstellungen**
- **Priorität:** Skala von 1-5 mit beschreibenden Labels
- **Reihenfolge-Anpassung:** Feinabstimmung der Verarbeitungsreihenfolge innerhalb von Prioritätsstufen
- **Budget-Steuerung:** Begrenze, wie viel des World Info/Kontext-Budgets jedes Lorebook nutzen darf.
  - **Standard (Default):** Kein Limit pro Lorebook (kein STLO-Trimmen); SillyTavern entscheidet. STLO sortiert nur die Einträge.
  - **% of World Info budget:** Begrenze dieses Lorebook auf einen Prozentsatz des World Info Token-Pools.
  - **% of Max Context:** Begrenze durch einen Prozentsatz des maximal nutzbaren Kontextfensters des Modells.
  - **Fixed tokens:** Setze ein spezifisches Token-Limit für dieses Lorebook.
  - Budgets werden unter Verwendung der vorherrschenden Kontextgröße von `getMaxContextSize()` berechnet, und die Durchsetzung erfordert die Strategie "evenly".
  - **Tipp:** Standard (0) lässt SillyTavern das Budget verwalten. "Fixed" mit 1 wird das Lorebook abwürgen.
- **Auto-save:** Einstellungen werden bei Änderung automatisch gespeichert

### **Globales Verhalten**
- **Strategie-Validierung:** Erkennt automatisch, ob die Strategie "evenly" erforderlich ist
- **Smarte Warnungen:** Zeigt Kompatibilitätswarnungen nur während der tatsächlichen Generierung (nicht beim Laden des Chats)
- **Generierungs-Tracking:** Unterscheidet zwischen automatischen Begrüßungen und vom Nutzer initiierter Generierung

---

## 🚨 Kompatibilität & Warnungen

### **Strategie-Anforderungen**
STLO benötigt die World Info Einfügestrategie "evenly", um zu funktionieren. Wenn die Erweiterung erkennt, dass:
- Spezielle Lorebook-Einstellungen konfiguriert sind
- Die Strategie NICHT auf "evenly" gesetzt ist

Wirst du ein Warn-Popup sehen mit den Optionen:
- **Stop Generation:** Generierung anhalten, um Einstellungen zuerst zu korrigieren
- **Disable STLO:** Fortfahren ohne Lorebook-Sortierung

### **Best Practices**
- Nutze immer die Strategie "evenly", wenn STLO aktiv ist
- Teste Prioritätseinstellungen zuerst mit einer kleinen Konversation
- Nutze die Reihenfolge-Anpassung sparsam für Feinabstimmungen

---

## 🔧 Fortgeschrittene Nutzung

### **Multi-Lorebook Szenarien**
- **Charakter + Welt:** Setze das Charakter-Lorebook auf Priorität Hoch/Höchste
- **Erinnerungen/LTM:** Setze Erinnerungen auf niedrigste Priorität
- **Reihenfolge-Kontrolle:** Nutze Reihenfolge-Anpassung für feinkörnige Kontrolle innerhalb von Prioritätsstufen

### **Gruppenchat Fortgeschrittene Strategien**
- **Charakter-Spezialisierung:** Gib jedem Charakter hohe Priorität auf seine relevanten Lorebooks
  - Gelehrter: Hohe Priorität auf "Magie Theorie" Lorebook, Normale Priorität auf "Kampftaktiken"
  - Krieger: Hohe Priorität auf "Kampftaktiken" Lorebook, Niedrige Priorität auf "Magie Theorie"
- **Reihenfolge-Feinabstimmung:** Nutze Reihenfolge-Anpassung, um charakterspezifische Inhalte zu stärken
  - Charakterspezifische Lorebooks: +500 Reihenfolge-Anpassung für diesen Charakter
  - Allgemeine Lorebooks: 0 Reihenfolge-Anpassung (Standard)
- **Lore-Konsistenz:** Stelle sicher, dass charakterspezifische Informationen nur während deren Zügen erscheinen
  - Charakter-Hintergrund Lorebooks auf Priorität 5 für diesen Charakter, Priorität 1 für andere

---

*Vibe Coded mit Cline und verschiedenen LLMs.* 🎯✨
