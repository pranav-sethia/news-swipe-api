const { pipeline } = require('@xenova/transformers');

async function test() {
  console.log("Starting download...");
  try {
    const summarizer = await pipeline('summarization', 'Xenova/distilbart-cnn-6-6', {
      quantized: true,
      progress_callback: (info) => {
        console.log(`[${info.status}] ${info.name}: ${info.progress ? Math.round(info.progress) + '%' : ''}`);
      }
    });
    console.log("Success! Summarizer loaded.");
  } catch (err) {
    console.error("Error:", err);
  }
}
test();
