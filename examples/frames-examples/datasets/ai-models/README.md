# ai-models

Every notable AI model release across vendors and modalities. The dataset
captures the cadence of the field — who shipped what, when, on which
benchmarks — without taking a side on quality.

## In scope

- Frontier and mid-tier models from any vendor with a public announcement.
- All modalities: text, image, audio, video, multimodal, embeddings.
- Open-weights releases on Hugging Face with >= 1k downloads in first month.

## Out of scope

- Fine-tunes that don't change architecture or training data meaningfully.
- Internal-only models without a public release.
- Toy / research-only checkpoints with no usage path.

## Refresh policy

Daily. New releases are added on announcement day. `benchmark_score` is
refreshed when vendors update model cards or third parties publish
independent evals.
