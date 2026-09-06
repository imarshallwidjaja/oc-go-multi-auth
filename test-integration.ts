#!/usr/bin/env bun
// Test script to demonstrate LanguageTool + Caveman integration
import { languageToolCheck } from "./src/languagetool"
import { cavemanCompress, detectLanguage } from "./src/caveman"

const testMessage = `Bonjour, je suis en train de travailler sur un projet important. 
J'ai besoin de créer une fonction qui permet de valider les entrées utilisateur 
et de gérer les erreurs de manière élégante. La fonction doit vérifier que les 
champs obligatoires sont remplis, que les emails sont au bon format, et que les 
mots de passe respectent les critères de sécurité. En cas d'erreur, elle doit 
retourner un message d'erreur clair et précis.`

async function main() {
  console.log("=== Test LanguageTool + Caveman Integration ===\n")
  
  console.log("1. Message original:")
  console.log(testMessage)
  console.log(`\nLongueur: ${testMessage.length} caractères\n`)

  // Test LanguageTool
  console.log("2. Test LanguageTool (détection de langue + correction)...")
  try {
    const ltResult = await languageToolCheck(testMessage, "http://192.168.1.69:8010")
    console.log(`   Langue détectée: ${ltResult.language}`)
    console.log(`   Corrections trouvées: ${ltResult.matches.length}`)
    console.log(`   Texte corrigé: ${ltResult.correctedText.substring(0, 100)}...`)
  } catch (error) {
    console.log(`   ⚠️ LanguageTool non disponible: ${error.message}`)
    console.log("   Utilisation du texte original")
  }

  // Test détection de langue
  console.log("\n3. Test détection de langue (simple)...")
  const detectedLang = detectLanguage(testMessage)
  console.log(`   Langue détectée: ${detectedLang}`)

  // Test Caveman
  console.log("\n4. Test Caveman (compression MLM)...")
  try {
    const compressed = await cavemanCompress(testMessage, "fr", "http://192.168.1.69:3000")
    console.log(`   Texte compressé: ${compressed}`)
    console.log(`\n   Longueur originale: ${testMessage.length} caractères`)
    console.log(`   Longueur compressée: ${compressed.length} caractères`)
    console.log(`   Ratio de compression: ${(compressed.length / testMessage.length * 100).toFixed(1)}%`)
  } catch (error) {
    console.log(`   ⚠️ Caveman non disponible: ${error.message}`)
    console.log("   Utilisation de la compression simple...")
    
    // Simple compression fallback
    const simpleCompressed = testMessage
      .split(/\s+/)
      .filter(word => !["le", "la", "les", "de", "des", "du", "un", "une", "et", "est", "sont", "avoir", "être", "faire"].includes(word.toLowerCase()))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    
    console.log(`   Texte compressé (simple): ${simpleCompressed}`)
    console.log(`\n   Longueur originale: ${testMessage.length} caractères`)
    console.log(`   Longueur compressée: ${simpleCompressed.length} caractères`)
    console.log(`   Ratio de compression: ${(simpleCompressed.length / testMessage.length * 100).toFixed(1)}%`)
  }

  console.log("\n=== Fin du test ===")
}

main().catch(console.error)
