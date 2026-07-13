package com.peakcut.sdk;

import com.peakcut.sdk.model.AgentEvent;
import com.peakcut.sdk.model.CreateJobRequest;
import com.peakcut.sdk.model.JobState;
import com.peakcut.sdk.model.SourceType;
import com.peakcut.sdk.model.Verdict;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Unit tests for the pure model types — enum parsing, terminal-state logic,
 *  request validation, and the activity humanizer. */
class ModelTest {

    @Test
    void jobStateParsesWireTokensCaseInsensitively() {
        assertEquals(JobState.PROCESSING, JobState.fromWire("processing"));
        assertEquals(JobState.DONE, JobState.fromWire("DONE"));
        assertEquals(JobState.FAILED, JobState.fromWire("  failed "));
        assertThrows(IllegalArgumentException.class, () -> JobState.fromWire("bogus"));
    }

    @Test
    void onlyDoneAndFailedAreTerminal() {
        assertTrue(JobState.DONE.isTerminal());
        assertTrue(JobState.FAILED.isTerminal());
        assertFalse(JobState.QUEUED.isTerminal());
        assertFalse(JobState.PROCESSING.isTerminal());
    }

    @Test
    void enumsRoundTripThroughTheirWireValue() {
        for (JobState s : JobState.values()) {
            assertEquals(s, JobState.fromWire(s.wireValue()));
        }
        for (Verdict v : Verdict.values()) {
            assertEquals(v, Verdict.fromWire(v.wireValue()));
        }
        for (SourceType t : SourceType.values()) {
            assertEquals(t, SourceType.fromWire(t.wireValue()));
        }
    }

    @Test
    void createJobRequestValidatesAndTagsSource() {
        CreateJobRequest url = CreateJobRequest.fromUrl("  https://youtu.be/x ");
        assertEquals(SourceType.URL, url.sourceType());
        assertEquals("https://youtu.be/x", url.source());

        CreateJobRequest upload = CreateJobRequest.fromUpload("u/me/abc/video.mp4");
        assertEquals(SourceType.UPLOAD, upload.sourceType());

        assertThrows(IllegalArgumentException.class, () -> CreateJobRequest.fromUrl(""));
        assertThrows(IllegalArgumentException.class, () -> CreateJobRequest.fromUpload("  "));
    }

    @Test
    void agentEventHumanizesKnownAgents() {
        assertEquals("Critic is scoring candidates",
                new AgentEvent("critic", "scored", null).humanize());
        assertEquals("Trimming cuts to clean edges",
                new AgentEvent("surgeon", "refined", null).humanize());
        // Unknown agent falls back to its own name, never throws.
        assertEquals("mystery", new AgentEvent("mystery", "x", null).humanize());
    }
}
