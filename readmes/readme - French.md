# 📚 Ordonnancement de Lorebook (Une Extension pour SillyTavern)

Une extension pour SillyTavern qui ajoute une gestion des priorités et un budget au niveau du lorebook pour les Informations sur le Monde (World Info). Elle permet un contrôle total sur les lorebooks qui s'activent en premier et permet de limiter les lorebooks trop "gourmands". Parfait pour les utilisateurs ayant plusieurs lorebooks et nécessitant un contrôle précis du comportement des Informations sur le Monde.

---

💡 **Vous voulez libérer toute la puissance de la gestion de la mémoire ?**
Utilisez STLO conjointement avec [SillyTavern-MemoryBooks (STMB)](https://github.com/aikohanasaki/SillyTavern-MemoryBooks) pour obtenir les meilleurs résultats !
Consultez le [Guide STMB + STLO](guides/STMB%20and%20STLO%20-%20English.md) (en anglais) pour des conseils de configuration et pour vous assurer que vos souvenirs sont correctement priorisés.

---

🌐 **Cherchez-vous de la documentation ou des guides dans une autre langue ?**
Veuillez consulter le dossier [`/readmes/`](readmes/) pour les fichiers lisez-moi traduits, et le dossier [`/guides/`](guides/) pour les guides traduits dans votre langue !

🆕 **Prend désormais en charge les dérogations (overrides) spécifiques aux personnages dans les discussions de groupe et l'ajustement précis de l'ordre !**

**📋 [Historique des versions & Journal des modifications (Changelog)](CHANGELOG.md)**

## FAQ
Les paramètres sont accessibles via le bouton "Lorebook Ordering" dans le panneau Informations sur le Monde (World Info) (il apparaît à côté de la barre de recherche lorsque des lorebooks sont disponibles).

![Bouton STLO](https://github.com/aikohanasaki/imagehost/blob/main/STLO.png)

Q : Est-ce que cela fonctionne vraiment ? Pourquoi vois-je toutes les entrées dans les infos du World Info ?
R : Oui, cela fonctionne. Si vous regardez dans la Console (F12), vous verrez `[STLO] Trimmed WI entry` enregistrant chaque entrée unique qui a été supprimée.

---

## 📋 Prérequis

- **SillyTavern :** 1.13.5+ (dernière version recommandée)
- **Stratégie World Info :** DOIT utiliser la stratégie d'insertion "evenly" (équitablement) pour que STLO fonctionne
- **Lorebooks Multiples :** L'extension est surtout utile lorsque vous avez plusieurs lorebooks nécessitant une priorisation

## 💡 Paramètres recommandés pour l'activation globale World Info/Lorebook
Testé avec ces paramètres :

- **Stratégie d'insertion (Insertion Strategy) :** "evenly" (requis pour que STLO fonctionne)
- **Étapes de récursion max (Max Recursion Steps) :** 2 (recommandation générale)

---

## 🚀 Pour Commencer

### 1. **Installer & Configurer**
- Installez l'extension dans votre dossier d'extensions SillyTavern
- Assurez-vous d'avoir plusieurs lorebooks disponibles
- Réglez la stratégie d'insertion des Informations sur le Monde sur "evenly" dans les paramètres de SillyTavern

![Bouton Extension](https://github.com/aikohanasaki/imagehost/blob/main/settings.png)

### 2. **Accéder aux Paramètres**
- Ouvrez le panneau Informations sur le Monde (World Info) dans SillyTavern
- Cherchez le bouton "Lorebook Ordering" à côté de la barre de recherche
- Cliquez pour ouvrir la fenêtre de gestion des lorebooks

### 3. **Configurer les Priorités**
- Sélectionnez un lorebook dans le menu déroulant
- Définissez le niveau de priorité (1=Le plus bas à 5=Le plus haut, 3=Défaut)
- Définissez le budget (si désiré)
- Configurez l'ajustement de l'ordre si nécessaire
- Sauvegardez et répétez pour les autres lorebooks

![Paramètres de base (globaux)](https://github.com/aikohanasaki/imagehost/blob/main/STLO%20basic.png)

---

## ⌨️ Commande Slash : /stlo

Ouvrez la fenêtre de Priorité & Budget STLO pour un lorebook spécifique directement depuis la zone de saisie du chat.

- Description : Accès rapide aux paramètres STLO pour un lorebook donné
- Utilisation :

```

/stlo <nom du lorebook>

```
- Argument :
- nom du lorebook (insensible à la casse). Vous pouvez taper des noms avec des espaces sans guillemets ; les guillemets sont optionnels.
- Exemples :
- `/stlo Mon Lorebook`
- `/stlo "Lore du Monde"`
- `/stlo Alice`

Ce que cela fait :
- Sélectionne le lorebook correspondant dans l'éditeur World Info
- Ouvre la fenêtre d'ordonnancement de Lorebook (ST Lorebook Ordering) pour ce lorebook

Notes :
- Nécessite un fichier World Info existant. Si aucun n'est sélectionné/disponible, vous verrez : "Create or select a World Info file first."
- Si le nom ne correspond à aucun lorebook, vous verrez : "Lorebook not found: NOM"
- Si vous omettez le nom du lorebook, vous verrez l'indice d'utilisation : "Usage: /stlo <lorebook name>"
- STLO nécessite toujours la stratégie d'insertion "evenly" pour que l'ordonnancement et les budgets prennent effet

---

## 🎯 Niveaux de Priorité

### **Système de Priorité**
- **Le plus haut (5) :** Les entrées du lorebook s'activent en premier et sont prioritaires dans l'allocation du budget
- **Haut (4) :** Priorité supérieure à la valeur par défaut
- **Défaut (3) :** Comportement standard de SillyTavern (inchangé par rapport à l'original)
- **Bas (2) :** Priorité inférieure à la valeur par défaut
- **Le plus bas (1) :** Les entrées du lorebook s'activent en dernier

### **Comment ça marche**
- Les lorebooks à priorité élevée sont traités en premier lors de l'activation des Informations sur le Monde
- Ne fonctionne qu'avec la stratégie d'insertion "evenly"

---

## 📊 Système d'Ajustement de l'Ordre

### **Réglage fin au-delà de la Priorité**
Le Système d'Ajustement de l'Ordre permet un contrôle précis sur l'ordre de traitement des entrées de lorebook au sein du même niveau de priorité :

- **Plage d'ajustement :** Valeurs de -10 000 à +10 000 ajoutées au-dessus des calculs de priorité
- **Contrôle Précis :** Ajustez finement l'ordre de traitement sans changer les niveaux de priorité
- **Formule Mathématique :** `Ordre Final = Priorité × 10 000 + Ajustement d'Ordre + Ordre d'Entrée Original`

### **Exemple d'Utilisation**

```

Lorebook A : Priorité 3, Ajustement d'Ordre +250
Lorebook B : Priorité 3, Ajustement d'Ordre -100
Lorebook C : Priorité 3, Ajustement d'Ordre 0 (défaut)

Ordre de Traitement Final :

1. Lorebook A : 30 250 + ordre d'entrée (traité en premier)
2. Lorebook C : 30 000 + ordre d'entrée (défaut)
3. Lorebook B : 29 900 + ordre d'entrée (traité en dernier)

```

### **Contrôles de Discussion de Groupe**
- **Toujours Appliquer (Always Apply) :** L'ajustement de l'ordre fonctionne à la fois dans les chats solo et les chats de groupe (par défaut)
- **Chats de Groupe Uniquement (Group Chats Only) :** Cochez cette option pour n'appliquer l'ajustement de l'ordre que pendant les chats de groupe
- **Surcharges de Personnage :** Définissez des ajustements d'ordre différents pour des personnages spécifiques dans les chats de groupe

### **Quand utiliser l'Ajustement de l'Ordre**
- **Personnage vs Monde :** Boostez légèrement les lorebooks spécifiques aux personnages au-dessus des informations générales sur le monde
- **Hiérarchie du Lore :** Assurez-vous que le lore critique soit traité avant les informations supplémentaires
- **Gestion de la Mémoire :** Ajustez finement quand les souvenirs/entrées LTM s'activent par rapport aux autres contenus
- **Priorités de Dialogue :** Contrôlez quand les lorebooks liés au dialogue s'activent dans les conversations

---

## 🎭 Surcharges de Personnage en Discussion de Groupe (Overrides)

![Paramètres spécifiques aux discussions de groupe](https://github.com/aikohanasaki/imagehost/blob/main/STLO%20group.png)

### **Personnalisation Par Personnage**
Dans les discussions de groupe, différents personnages peuvent désormais avoir des comportements de lorebook différents pendant leurs tours individuels :

- **Priorités Spécifiques au Personnage :** Alice pourrait utiliser un lorebook avec une Priorité 5, tandis que Bob utilise le même lorebook avec une Priorité 2
- **Ajustement d'Ordre Individuel :** Chaque personnage peut avoir des valeurs d'ajustement d'ordre personnalisées pour le même lorebook
- **Intégration Transparente :** Fonctionne automatiquement pendant la génération de chat de groupe - aucune configuration supplémentaire requise

### **Comment fonctionnent les Surcharges de Groupe**
1. **Configurer la Surcharge :** Dans les paramètres du lorebook, développez la section "Group Chat Overrides"
2. **Sélectionner les Personnages :** Choisissez quels personnages obtiennent des paramètres spéciaux pour ce lorebook
3. **Définir les Valeurs Personnalisées :** Chaque personnage peut avoir des paramètres de priorité et d'ajustement d'ordre uniques
4. **Application Automatique :** Pendant le chat de groupe, quand c'est le tour d'Alice, elle utilise ses paramètres de surcharge ; quand c'est le tour de Bob, il utilise les siens

### **Exemples de Scénarios**
- **Lorebook Centré sur un Personnage :** Réglez le lorebook personnel du personnage sur Priorité 5 pour lui, et Priorité 1 pour les autres
- **Spécialisation du Lore :** Un personnage érudit obtient une haute priorité sur les lorebooks académiques, un guerrier obtient une basse priorité
- **Réglage fin de l'Ordre :** Boostez le contenu spécifique au personnage avec des ajustements d'ordre positifs

### **Notes Importantes**
- **Comportement en Chat Solo :** Les surcharges de personnage sont ignorées dans les chats à un seul personnage (utilise les paramètres par défaut du lorebook)
- **Logique de Repli :** Les personnages sans surcharges spécifiques utilisent les paramètres par défaut du lorebook
- **Pas de Conflits :** Passer d'un chat de groupe à un chat solo efface automatiquement l'état de surcharge

---

## ⚙️ Paramètres & Configuration

### **Paramètres Par Lorebook**
- **Priorité :** Échelle de 1 à 5 avec des étiquettes descriptives
- **Ajustement d'Ordre :** Réglage fin de l'ordre de traitement au sein des niveaux de priorité
- **Contrôles de Budget :** Limitez la quantité de budget Informations sur le Monde/contexte que chaque lorebook peut utiliser.
  - **Défaut :** Pas de limite par lorebook (pas de coupure STLO) ; SillyTavern décide. STLO ordonne seulement les entrées.
  - **% du budget World Info :** Restreint ce lorebook à un pourcentage du pool de tokens des Informations sur le Monde.
  - **% du Contexte Max :** Restreint par un pourcentage de la fenêtre de contexte maximale utilisable du modèle.
  - **Tokens fixes :** Définit une limite de tokens spécifique pour ce lorebook.
  - Les budgets sont calculés en utilisant la taille de contexte prévalente via `getMaxContextSize()`, et l'application nécessite la stratégie "evenly".
  - **Astuce :** Le réglage par défaut (0) laisse SillyTavern gérer le budget. Un budget fixe à 1 étouffera le lorebook.
- **Sauvegarde auto :** Les paramètres sont automatiquement sauvegardés lorsqu'ils sont modifiés

### **Comportement Global**
- **Validation de la Stratégie :** Détecte automatiquement si la stratégie "evenly" est requise
- **Avertissements Intelligents :** Affiche uniquement les avertissements de compatibilité pendant la génération réelle (pas au chargement du chat)
- **Suivi de Génération :** Distingue entre les salutations automatiques et la génération initiée par l'utilisateur

---

## 🚨 Compatibilité & Avertissements

### **Exigences de Stratégie**
STLO nécessite la stratégie d'insertion "evenly" (équitablement) des Informations sur le Monde pour fonctionner. Lorsque l'extension détecte que :
- Des paramètres spéciaux de lorebook sont configurés
- La stratégie N'EST PAS réglée sur "evenly"

Vous verrez une fenêtre d'avertissement avec des options pour :
- **Arrêter la Génération :** Arrêter la génération pour corriger les paramètres d'abord
- **Désactiver STLO :** Continuer sans l'ordonnancement de lorebook

### **Meilleures Pratiques**
- Utilisez toujours la stratégie "evenly" lorsque STLO est actif
- Testez les paramètres de priorité avec une petite conversation d'abord
- Utilisez l'ajustement de l'ordre avec parcimonie pour le réglage fin

---

## 🔧 Utilisation Avancée

### **Scénarios Multi-Lorebook**
- **Personnage + Monde :** Réglez le lorebook de personnage sur une priorité Haute/La plus haute
- **Souvenirs/LTM :** Réglez les souvenirs sur la priorité la plus basse
- **Contrôle de l'Ordre :** Utilisez l'ajustement de l'ordre pour un contrôle granulaire au sein des niveaux de priorité

### **Stratégies Avancées de Chat de Groupe**
- **Spécialisation des Personnages :** Donnez à chaque personnage une priorité élevée sur ses lorebooks pertinents
  - Érudit : Priorité élevée sur le lorebook "Théorie Magique", priorité Normale sur "Tactiques de Combat"
  - Guerrier : Priorité élevée sur le lorebook "Tactiques de Combat", priorité Basse sur "Théorie Magique"
- **Réglage fin de l'Ordre :** Utilisez l'ajustement de l'ordre pour booster le contenu spécifique aux personnages
  - Lorebooks spécifiques au personnage : Ajustement d'ordre +500 pour ce personnage
  - Lorebooks généraux : Ajustement d'ordre 0 (défaut)
- **Cohérence du Lore :** Assurez-vous que les informations spécifiques au personnage n'apparaissent que pendant leurs tours
  - Lorebooks d'histoire du personnage réglés sur Priorité 5 pour ce personnage, Priorité 1 pour les autres

---

*Codé "au feeling" avec Cline et divers LLMs.* 🎯✨
