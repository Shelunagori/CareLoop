# Recorded extractions

Real extraction-model output, captured once and committed.

Golden tests replay these through the production ingestion pipeline. That makes
the entire deterministic half — resolution, evidence, temporal, salience,
episode membership — reproducible byte-for-byte, with no network and no cost,
while still being anchored to what the model actually returns.

Each file is keyed by the prompt version it was recorded under. Re-record when
`extraction.v1` changes; that is what the version in the filename is for.
