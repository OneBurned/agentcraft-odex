package dev.agentcraft.text;

import org.junit.Test;
import static org.junit.Assert.*;

public class ConversationTextTest {
    @Test public void keepsEveryParagraphAndListItemPastOldFiveLineLimit() {
        String source = "\nНачало\n\n";
        for (int i = 1; i <= 30; i++) source += i + ". Пункт " + i + "\n";
        source += "\nКонец ответа";
        assertEquals(source, ConversationText.readable(source));
    }
    @Test public void removesFormattingMarkersWithoutChangingCodeOrLosingNewlines() {
        String text = "## Заголовок\r\n\r\n**Важно**: `file.ts`\r\n```js\r\n  a ** b;\r\n\r\n  `raw`;\r\n```\r\nПоследний абзац";
        assertEquals("Заголовок\n\nВажно: file.ts\n  a ** b;\n\n  `raw`;\nПоследний абзац", ConversationText.readable(text));
    }
}
