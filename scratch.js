const sampleText = `React 19 RC is now available. In React 19, we’re adding support for a new hook: useActionState. This allows you to update state based on the result of a form action. We are also introducing a new compiler that automatically memoizes your components, removing the need for useMemo and useCallback in most cases. This massive change to the UI architecture will significantly improve web performance and developer experience for frontend engineers globally.`;

async function testPrompt(systemPrompt, promptText) {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        system: systemPrompt,
        prompt: promptText + "\n\nText:\n" + sampleText,
        stream: false,
        format: "json"
      })
    });
    const data = await res.json();
    return data.response;
  } catch(e) { return e.message; }
}

async function runTests() {
  const systemPrompt = `You are an expert data extraction algorithm. You ONLY output valid JSON. Do not include any conversational text.`;
  
  const prompt1 = `Analyze the following text and extract exactly 3 bullet points (under 12 words each), 1 category from the list [Software Engineering, Hardware & Systems, Artificial Intelligence, Startups & VC, Cybersecurity, Business & Finance, Science & Space, Design & UI/UX, Web3 & Crypto, Other], 3 highly specific technical tags (e.g., specific framework names, noun phrases, no stop words), and an estimated read_time_minutes.
  
  JSON Schema:
  {
    "category": "string",
    "tags": ["string", "string", "string"],
    "read_time_minutes": number,
    "bullets": ["string", "string", "string"]
  }`;

  console.log("=== TEST 1 ===");
  console.log(await testPrompt(systemPrompt, prompt1));
}

runTests();
