package dev.agentcraft.text;

/** Light formatting for a plain-text game chat; never collapses paragraphs or cuts content. */
public final class ConversationText {
    private ConversationText() {}
    public static String readable(String source) {
        java.util.List<String> out = new java.util.ArrayList<>();
        boolean code = false;
        for (String line : source.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1)) {
            if (line.stripLeading().startsWith("```")) { code = !code; continue; }
            if (!code) {
                line = line.replaceFirst("^#{1,6}\\s+", "")
                    .replaceAll("\\*\\*([^*\\n]+)\\*\\*", "$1")
                    .replaceAll("`([^`\\n]+)`", "$1");
            }
            out.add(line);
        }
        return String.join("\n", out);
    }
}
