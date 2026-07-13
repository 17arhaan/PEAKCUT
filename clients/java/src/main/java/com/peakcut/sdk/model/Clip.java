package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Objects;
import java.util.Optional;

/**
 * A single clip a job produced. Ready clips carry playable media URLs and a score;
 * clips that were rendered but failed the QA gate are marked {@code DROPPED} with a
 * reason and no media.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class Clip {

    private final int index;
    private final ClipStatus status;
    private final Integer score;
    private final String hook;
    private final String droppedReason;
    private final String mp4Url;
    private final String thumbUrl;
    private final ClipEvidence evidence;

    public Clip(
            @JsonProperty("index") int index,
            @JsonProperty("status") ClipStatus status,
            @JsonProperty("score") Integer score,
            @JsonProperty("hook") String hook,
            @JsonProperty("dropped_reason") String droppedReason,
            @JsonProperty("mp4_url") String mp4Url,
            @JsonProperty("thumb_url") String thumbUrl,
            @JsonProperty("evidence") ClipEvidence evidence) {
        this.index = index;
        this.status = status;
        this.score = score;
        this.hook = hook;
        this.droppedReason = droppedReason;
        this.mp4Url = mp4Url;
        this.thumbUrl = thumbUrl;
        this.evidence = evidence;
    }

    /** The clip's position in the job (1-based). */
    public int index() {
        return index;
    }

    /** Whether the clip is ready to play or was dropped at QA. */
    public ClipStatus status() {
        return status;
    }

    /** True if this clip is playable/downloadable. */
    public boolean isReady() {
        return status == ClipStatus.READY;
    }

    /** The 0..100 score, present for ready clips. */
    public Optional<Integer> score() {
        return Optional.ofNullable(score);
    }

    /** The on-screen hook title, if one was written. */
    public Optional<String> hook() {
        return Optional.ofNullable(hook);
    }

    /** For dropped clips, why (e.g. {@code "LUFS"}, {@code "BLACK"}, {@code "ALIGN"}). */
    public Optional<String> droppedReason() {
        return Optional.ofNullable(droppedReason);
    }

    /** A time-limited URL to the rendered mp4 (ready clips only). */
    public Optional<String> mp4Url() {
        return Optional.ofNullable(mp4Url);
    }

    /** A time-limited URL to the thumbnail (ready clips only). */
    public Optional<String> thumbUrl() {
        return Optional.ofNullable(thumbUrl);
    }

    /** The full scoring/evidence receipt, when the API included it. */
    public Optional<ClipEvidence> evidence() {
        return Optional.ofNullable(evidence);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof Clip other)) {
            return false;
        }
        return index == other.index
                && status == other.status
                && Objects.equals(score, other.score)
                && Objects.equals(hook, other.hook)
                && Objects.equals(droppedReason, other.droppedReason)
                && Objects.equals(mp4Url, other.mp4Url)
                && Objects.equals(thumbUrl, other.thumbUrl)
                && Objects.equals(evidence, other.evidence);
    }

    @Override
    public int hashCode() {
        return Objects.hash(index, status, score, hook, droppedReason, mp4Url, thumbUrl, evidence);
    }

    @Override
    public String toString() {
        return "Clip{index=" + index + ", status=" + status + ", score=" + score
                + ", hook=" + hook + ", droppedReason=" + droppedReason + '}';
    }
}
