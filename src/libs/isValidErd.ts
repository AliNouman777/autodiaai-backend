import natural from "natural";

const TfIdf = natural.TfIdf;
const tokenizer = new natural.WordTokenizer();
const tfidf = new TfIdf();
const stopwords = new Set(natural.stopwords);

/** Expanded ERD-related training prompts */
const referencePrompts = [
  "Create an ER diagram for a school management system",
  "Generate a database schema for an e-commerce store",
  "Design a relational model for a hospital database",
  "Draw an ERD for a social media application",
  "Generate entity relationship diagram for an inventory system",
  "Plan a database design for a booking platform",
  "Model the tables and relationships for a warehouse system",
  "Design a schema for managing customers, orders, and products",
  "Create an entity relationship model for a library",
  "Database structure for tracking employees, departments, and salaries"
];

/** Preprocess text: lowercase, tokenize, remove stopwords, stem */
function preprocess(text: string): string {
  return tokenizer
    .tokenize(text.toLowerCase())
    .filter((word) => word.length > 2 && !stopwords.has(word))
    .map((word) => natural.PorterStemmer.stem(word))
    .join(" ");
}

// Train TF-IDF model on preprocessed reference prompts
referencePrompts.forEach((doc) => tfidf.addDocument(preprocess(doc)));

/**
 * Checks whether a prompt is likely related to ERD/database design.
 * @param prompt The user-provided prompt
 * @returns boolean indicating ERD relevance
 */
export function isValidErd(prompt: string): boolean {
  if (!prompt || prompt.trim().length < 3) return false;

  const processedPrompt = preprocess(prompt);

  let scores: number[] = [];
  tfidf.tfidfs(processedPrompt, (_i, measure) => {
    scores.push(measure);
  });

  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const maxScore = Math.max(...scores);

  // Dynamic threshold: lower for long, detailed prompts; higher for very short ones
  const threshold = processedPrompt.split(" ").length <= 4 ? 0.25 : 0.15;

  return avgScore >= threshold || maxScore >= threshold + 0.05;
}
