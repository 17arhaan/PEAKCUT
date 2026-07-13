package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * One of the four components the Critic scores a clip on — hook strength, payoff,
 * emotion, or quotability — each worth up to 25 points, together with the evidence
 * that backs the score. A component only counts if at least one of its evidence
 * items resolved against the measured signals; otherwise it is voided to zero.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class ScoreComponent {

    private final String name;
    private final int score;
    private final List<EvidenceItem> evidence;

    public ScoreComponent(
            @JsonProperty("name") String name,
            @JsonProperty("score") int score,
            @JsonProperty("evidence") List<EvidenceItem> evidence) {
        this.name = name;
        this.score = score;
        this.evidence = evidence == null ? List.of() : List.copyOf(evidence);
    }

    /** The component name, e.g. {@code "hook_strength"}. */
    public String name() {
        return name;
    }

    /** The awarded score, 0..25. */
    public int score() {
        return score;
    }

    /** True when the component was voided (no evidence resolved, so it scored zero). */
    public boolean isVoided() {
        return score == 0 && evidence.isEmpty();
    }

    /** The cited evidence for this component (never null). */
    public List<EvidenceItem> evidence() {
        return Collections.unmodifiableList(evidence);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof ScoreComponent other)) {
            return false;
        }
        return score == other.score
                && Objects.equals(name, other.name)
                && Objects.equals(evidence, other.evidence);
    }

    @Override
    public int hashCode() {
        return Objects.hash(name, score, evidence);
    }

    @Override
    public String toString() {
        return "ScoreComponent{name=" + name + ", score=" + score + ", evidence=" + evidence + '}';
    }
}
