-- ============================================================================
-- Lana — migration 008: timed transcript segments
--
-- Additive. Run after 007. Safe to re-run.
--
-- Deepgram's diarized response carries a start time per utterance; until now
-- transcribe-call kept only the text and threw the timing away. Storing it
-- lets the transcript view and the coaching evidence quotes seek the audio
-- player to the exact moment a line was said, instead of only playing from
-- the top.
--
-- [{start, end, speaker, text}, ...], one entry per line of the transcript,
-- in the same order — the frontend matches by array index, not by re-parsing
-- text, so this only ever applies to audio transcribed through Deepgram. A
-- manually pasted transcript has no audio to seek anyway.
-- ============================================================================

alter table public.call_recordings add column if not exists transcript_segments jsonb;
