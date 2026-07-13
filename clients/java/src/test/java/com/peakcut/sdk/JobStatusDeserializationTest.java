package com.peakcut.sdk;

import com.peakcut.sdk.http.JsonMapper;
import com.peakcut.sdk.model.Clip;
import com.peakcut.sdk.model.ClipStatus;
import com.peakcut.sdk.model.JobState;
import com.peakcut.sdk.model.JobStatus;
import com.peakcut.sdk.model.Verdict;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Verifies the SDK models deserialize a realistic status payload — the exact JSON
 * shape {@code GET /api/jobs/{id}/status} returns — including the nested clip
 * evidence and the snake_case-to-camelCase field mapping.
 */
class JobStatusDeserializationTest {

    private final JsonMapper json = new JsonMapper();

    private static final String DONE_PAYLOAD = """
        {
          "status": "done",
          "stage": "render",
          "progress": 1.0,
          "error": null,
          "active_style": "s1",
          "clips": [
            {
              "index": 1,
              "status": "ready",
              "score": 78,
              "hook": "Why I Never Smile",
              "dropped_reason": null,
              "mp4_url": "https://cdn.example/clip1.mp4",
              "thumb_url": "https://cdn.example/clip1.jpg",
              "evidence": {
                "total": 78,
                "verdict": "keep",
                "components": [
                  {"name": "hook_strength", "score": 22,
                   "evidence": [{"kind": "quote", "t": 654.0, "value": "No. I never smile."}]},
                  {"name": "payoff", "score": 18, "evidence": []}
                ]
              }
            },
            {
              "index": 2,
              "status": "dropped",
              "score": null,
              "hook": null,
              "dropped_reason": "LUFS",
              "mp4_url": null,
              "thumb_url": null,
              "evidence": null
            }
          ],
          "events": [
            {"agent": "scout", "action": "found", "created_at": "2026-07-13T10:00:00Z"},
            {"agent": "critic", "action": "scored", "created_at": "2026-07-13T10:01:00Z"}
          ]
        }
        """;

    @Test
    void parsesTerminalStatusWithClipsAndEvidence() {
        JobStatus status = json.read(DONE_PAYLOAD, JobStatus.class);

        assertEquals(JobState.DONE, status.state());
        assertTrue(status.isTerminal());
        assertEquals(100, status.progressPercent());
        assertEquals("render", status.stage().orElseThrow());
        assertEquals("s1", status.activeStyle().orElseThrow());

        assertEquals(2, status.clips().size());
        assertEquals(1, status.readyClips().size());
        assertEquals(2, status.events().size());
    }

    @Test
    void mapsReadyClipFieldsAndEvidence() {
        Clip clip = json.read(DONE_PAYLOAD, JobStatus.class).clips().get(0);

        assertEquals(1, clip.index());
        assertEquals(ClipStatus.READY, clip.status());
        assertTrue(clip.isReady());
        assertEquals(78, clip.score().orElseThrow());
        assertEquals("Why I Never Smile", clip.hook().orElseThrow());
        assertTrue(clip.mp4Url().isPresent());

        var evidence = clip.evidence().orElseThrow();
        assertEquals(78, evidence.total());
        assertEquals(Verdict.KEEP, evidence.verdict());
        assertEquals("hook_strength", evidence.topComponent().name());
        assertEquals(22, evidence.topComponent().score());
        assertTrue(evidence.components().get(1).isVoided());
    }

    @Test
    void mapsDroppedClipWithReasonAndNoMedia() {
        Clip dropped = json.read(DONE_PAYLOAD, JobStatus.class).clips().get(1);

        assertEquals(ClipStatus.DROPPED, dropped.status());
        assertFalse(dropped.isReady());
        assertEquals("LUFS", dropped.droppedReason().orElseThrow());
        assertTrue(dropped.mp4Url().isEmpty());
        assertTrue(dropped.score().isEmpty());
    }

    @Test
    void toleratesUnknownFieldsFromNewerApi() {
        String withExtra = "{\"status\":\"queued\",\"progress\":0.0,"
                + "\"clips\":[],\"events\":[],\"some_future_field\":42}";
        JobStatus status = json.read(withExtra, JobStatus.class);
        assertEquals(JobState.QUEUED, status.state());
        assertFalse(status.isTerminal());
    }
}
