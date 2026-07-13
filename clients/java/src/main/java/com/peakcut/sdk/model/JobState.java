package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Lifecycle state of a Peakcut job, as reported by the status endpoint.
 *
 * <p>The happy path is {@link #QUEUED} &rarr; {@link #PROCESSING} &rarr; {@link #DONE}.
 * A job that could not be produced ends in {@link #FAILED}.
 */
public enum JobState {

    /** Accepted and waiting for a worker to pick it up. */
    QUEUED("queued"),

    /** A worker is actively ingesting, analyzing, scoring, or rendering. */
    PROCESSING("processing"),

    /** Finished successfully; clips (if any survived QA) are available. */
    DONE("done"),

    /** Terminated without producing clips; see {@code JobStatus.error}. */
    FAILED("failed");

    private final String wire;

    JobState(String wire) {
        this.wire = wire;
    }

    /** The lowercase token used on the wire (matches the JSON the API returns). */
    @JsonValue
    public String wireValue() {
        return wire;
    }

    /** True once the job has reached a state that will never change again. */
    public boolean isTerminal() {
        return this == DONE || this == FAILED;
    }

    /**
     * Parse a wire token into a {@code JobState}, case-insensitively.
     *
     * @param value the token from the API (e.g. {@code "processing"})
     * @return the matching state
     * @throws IllegalArgumentException if no state matches
     */
    @JsonCreator
    public static JobState fromWire(String value) {
        if (value != null) {
            for (JobState state : values()) {
                if (state.wire.equalsIgnoreCase(value.trim())) {
                    return state;
                }
            }
        }
        throw new IllegalArgumentException("Unknown job state: " + value);
    }
}
