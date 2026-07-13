package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Objects;

/**
 * A single measured signal cited as evidence for a clip — for example an energy
 * spike, a laugh, or a quotable line. Every item was validated against the
 * measured {@code SignalIndex} on the worker before it was allowed to count, so
 * an {@code EvidenceItem} is a claim that actually resolved.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class EvidenceItem {

    private final String kind;
    private final Double t;
    private final String value;

    public EvidenceItem(
            @JsonProperty("kind") String kind,
            @JsonProperty("t") Double t,
            @JsonProperty("value") String value) {
        this.kind = kind;
        this.t = t;
        this.value = value;
    }

    /** The signal kind, e.g. {@code "energy_peak"}, {@code "laughter"}, {@code "quote"}. */
    public String kind() {
        return kind;
    }

    /** The timestamp (seconds into the source video) the signal was measured at. */
    public Double timestampSeconds() {
        return t;
    }

    /** The cited value as text (a sigma figure, a transcript snippet, …); may be null. */
    public String value() {
        return value;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof EvidenceItem other)) {
            return false;
        }
        return Objects.equals(kind, other.kind)
                && Objects.equals(t, other.t)
                && Objects.equals(value, other.value);
    }

    @Override
    public int hashCode() {
        return Objects.hash(kind, t, value);
    }

    @Override
    public String toString() {
        return "EvidenceItem{kind=" + kind + ", t=" + t + ", value=" + value + '}';
    }
}
