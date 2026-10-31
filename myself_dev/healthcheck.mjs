try {
  const response = await fetch("http://127.0.0.1:18382/health", { signal: AbortSignal.timeout(2000) });
  const health = await response.json();
  if (!response.ok || health.ready !== true || health.model !== "Qwen/Qwen3-Embedding-0.6B" || health.dimension !== 1024) throw new Error(JSON.stringify(health));
  console.log(JSON.stringify(health));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
