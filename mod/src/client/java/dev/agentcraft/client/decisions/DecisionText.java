package dev.agentcraft.client.decisions;

import dev.agentcraft.client.foreman.Protocol.Decision;

/** Full decision text shared by the compact card and the answer screen. */
public final class DecisionText {
    private DecisionText() {}

    public static String content(Decision decision) {
        String question = decision.question();
        String context = decision.context();
        if (context == null || context.isBlank() || context.equals(question)) return question;
        return question + "\n\n" + context;
    }
}
