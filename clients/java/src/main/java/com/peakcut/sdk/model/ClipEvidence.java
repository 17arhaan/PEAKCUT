package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.Objects;

/**
 * The full "why this clip" audit trail for a rendered clip: the total 0..100 score,
 * the verdict, and the per-component breakdown with cited evidence. This is exactly
 * the receipt Peakcut ships with every clip — the point of the product is that this
 * is never a black box.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class ClipEvidence {

    private final int total;
    private final Verdict verdict;
    private final List<ScoreComponent> components;

    public ClipEvidence(
            @JsonProperty("total") int total,
            @JsonProperty("verdict") Verdict verdict,
            @JsonProperty("components") List<ScoreComponent> components) {
        this.total = total;
        this.verdict = verdict;
        this.components = components == null ? List.of() : List.copyOf(components);
    }

    /** The summed 0..100 score across all components. */
    public int total() {
        return total;
    }

    /** The Critic's verdict ({@code KEEP} for anything that shipped). */
    public Verdict verdict() {
        return verdict;
    }

    /** The four scored components with their cited evidence (never null). */
    public List<ScoreComponent> components() {
        return components;
    }

    /**
     * Convenience: the single highest-scoring component — the strongest reason the
     * clip was kept — or {@code null} if there are none.
     */
    public ScoreComponent topComponent() {
        ScoreComponent best = null;
        for (ScoreComponent component : components) {
            if (best == null || component.score() > best.score()) {
                best = component;
            }
        }
        return best;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof ClipEvidence other)) {
            return false;
        }
        return total == other.total
                && verdict == other.verdict
                && Objects.equals(components, other.components);
    }

    @Override
    public int hashCode() {
        return Objects.hash(total, verdict, components);
    }

    @Override
    public String toString() {
        return "ClipEvidence{total=" + total + ", verdict=" + verdict + ", components=" + components + '}';
    }
}
