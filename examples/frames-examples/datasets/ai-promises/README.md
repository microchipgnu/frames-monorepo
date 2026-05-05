# ai-promises

A promise tracker for major AI labs. Every public roadmap commitment, dated,
with a `shipped?` field that gets answered later. Inspired by the Bible's
"Promise tracker" use case.

## In scope

- Specific, dated, public statements by labs (Anthropic, OpenAI, Google
  DeepMind, Meta AI, xAI, Mistral, Cohere) or their leadership.
- Commitments with a falsifiable shipping condition: "we will release X by Y",
  "we will open-source Z", "pricing will not increase before...".

## Out of scope

- Vague vision statements ("we believe in safe AI").
- Internal commitments leaked second-hand without primary source.
- Predictions about the field — only commitments by the actor themselves.

## Refresh policy

Daily. Each tick:
- Discovers new commitments from blog posts, transcripts, and earnings calls.
- For unshipped promises past their `target_date`, searches for shipping
  evidence and updates `shipped` + `shipped_at`.
- Never deletes a promise; resolution is permanent record.
