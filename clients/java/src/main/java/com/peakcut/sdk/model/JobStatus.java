package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.Optional;

/**
 * A snapshot of a job: its state, the current pipeline stage, progress in
 * {@code [0, 1]}, any error, the produced clips, and the recent agent-activity feed.
 * This is the shape returned by {@code GET /api/jobs/{id}/status} and the object a
 * {@link com.peakcut.sdk.JobPoller} hands back on each tick.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class JobStatus {

    private final JobState state;
    private final String stage;
    private final double progress;
    private final String error;
    private final String activeStyle;
    private final List<Clip> clips;
    private final List<AgentEvent> events;

    public JobStatus(
            @JsonProperty("status") JobState state,
            @JsonProperty("stage") String stage,
            @JsonProperty("progress") double progress,
            @JsonProperty("error") String error,
            @JsonProperty("active_style") String activeStyle,
            @JsonProperty("clips") List<Clip> clips,
            @JsonProperty("events") List<AgentEvent> events) {
        this.state = state;
        this.stage = stage;
        this.progress = progress;
        this.error = error;
        this.activeStyle = activeStyle;
        this.clips = clips == null ? List.of() : List.copyOf(clips);
        this.events = events == null ? List.of() : List.copyOf(events);
    }

    /** The job's lifecycle state. */
    public JobState state() {
        return state;
    }

    /** The current pipeline stage token (e.g. {@code "ingest"}, {@code "crew"}), if any. */
    public Optional<String> stage() {
        return Optional.ofNullable(stage);
    }

    /** Overall progress, {@code 0.0}..{@code 1.0}. */
    public double progress() {
        return progress;
    }

    /** Progress as a whole-number percentage, {@code 0}..{@code 100}. */
    public int progressPercent() {
        return (int) Math.round(progress * 100.0);
    }

    /** The failure message, present only when {@link #state()} is {@code FAILED}. */
    public Optional<String> error() {
        return Optional.ofNullable(error);
    }

    /** The caption style currently applied to the clip grid, if it has been restyled. */
    public Optional<String> activeStyle() {
        return Optional.ofNullable(activeStyle);
    }

    /** All clips the job has produced so far (never null). */
    public List<Clip> clips() {
        return clips;
    }

    /** Only the ready (playable) clips. */
    public List<Clip> readyClips() {
        return clips.stream().filter(Clip::isReady).toList();
    }

    /** The recent agent-activity feed (never null). */
    public List<AgentEvent> events() {
        return events;
    }

    /** True once the job will never change again ({@code DONE} or {@code FAILED}). */
    public boolean isTerminal() {
        return state != null && state.isTerminal();
    }

    @Override
    public String toString() {
        return "JobStatus{state=" + state + ", stage=" + stage
                + ", progress=" + progressPercent() + "%, clips=" + clips.size() + '}';
    }
}
