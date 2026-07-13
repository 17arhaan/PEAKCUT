package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Objects;

/**
 * The handle returned when a job is created. Carries the id you then poll for
 * {@link JobStatus}, along with the source it was created from.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class Job {

    private final String id;
    private final SourceType sourceType;
    private final String source;
    private final JobState state;

    public Job(
            @JsonProperty("jobId") String id,
            @JsonProperty("sourceType") SourceType sourceType,
            @JsonProperty("source") String source,
            @JsonProperty("status") JobState state) {
        this.id = id;
        this.sourceType = sourceType;
        this.source = source;
        this.state = state;
    }

    /** The job id — pass this to {@code getStatus} / {@code poll}. */
    public String id() {
        return id;
    }

    /** How the source was supplied ({@code URL} or {@code UPLOAD}). */
    public SourceType sourceType() {
        return sourceType;
    }

    /** The source URL or upload key. */
    public String source() {
        return source;
    }

    /** The state at creation time (usually {@code QUEUED} or {@code PROCESSING}). */
    public JobState state() {
        return state;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        return o instanceof Job other && Objects.equals(id, other.id);
    }

    @Override
    public int hashCode() {
        return Objects.hashCode(id);
    }

    @Override
    public String toString() {
        return "Job{id=" + id + ", sourceType=" + sourceType + ", state=" + state + '}';
    }
}
