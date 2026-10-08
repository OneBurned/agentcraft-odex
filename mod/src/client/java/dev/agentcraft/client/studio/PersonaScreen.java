package dev.agentcraft.client.studio;

import com.google.gson.JsonObject;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.ui.TextUtil;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.network.chat.Component;

/** One page per description/event, with local drafts retained until a successful bridge ack. */
public final class PersonaScreen extends Screen {
    private final Screen parent;
    private final String agentId;
    private PersonaDraft draft;
    private int page;
    private boolean busy, confirmReload, confirmClose;
    private String status = "Загружаю профиль…";
    private PersonaDraft.Layout bounds;
    private MultiLineEditBox field;

    public PersonaScreen(Screen parent, String agentId, String name) {
        super(Component.literal("Характер и фразы · " + name)); this.parent = parent; this.agentId = agentId;
    }
    @Override public boolean isPauseScreen() { return false; }
    @Override public void extractBackground(GuiGraphicsExtractor g, int mx, int my, float dt) {}
    @Override protected void init() {
        layout();
        if (draft == null && !busy) load();
    }
    private void layout() {
        clearWidgets(); bounds = PersonaDraft.Layout.at(width, height);
        int x = bounds.x(), w = bounds.width();
        button("←", x, 34, 26, () -> changePage(-1));
        button((page + 1) + "/" + PersonaDraft.TITLES.length + " · " + PersonaDraft.TITLES[page], x + 30, 34, w - 60, () -> changePage(1));
        button("→", x + w - 26, 34, 26, () -> changePage(1));
        field = addRenderableWidget(MultiLineEditBox.builder().setX(x).setY(bounds.fieldY()).build(font, w, bounds.fieldHeight(), Component.literal(PersonaDraft.TITLES[page])));
        // A paste may exceed the valid limit; leave it visible and reject save instead of silently truncating.
        field.setCharacterLimit(20_000);
        if (draft != null) {
            field.setValue(draft.value(page));
            final int currentPage = page;
            field.setValueListener(value -> { draft.set(currentPage, value); confirmClose = confirmReload = false; });
        }
        int bw = (w - 8) / 3;
        button(confirmClose ? "Закрыть без сохранения" : "Назад", x, bounds.buttonsY(), bw, this::onClose);
        button(confirmReload ? "Сбросить и перечитать" : "Перечитать", x + bw + 4, bounds.buttonsY(), bw, () -> {
            if (draft != null && draft.dirty() && !confirmReload) { confirmReload = true; status = "Повторное нажатие удалит несохранённые правки."; layout(); }
            else { confirmReload = confirmClose = false; load(); }
        });
        button("Сохранить всё", x + 2 * (bw + 4), bounds.buttonsY(), w - 2 * (bw + 4), () -> {
            if (draft == null) { status = "Сначала загрузи профиль кнопкой «Перечитать»."; return; }
            try { send("persona.save", draft.payload()); }
            catch (IllegalArgumentException e) { status = e.getMessage(); int invalid = draft.firstInvalidPage(); if (invalid >= 0) page = invalid; layout(); }
        });
        field.active = draft != null && !busy;
        if (busy) children().forEach(c -> { if (c instanceof AbstractWidget b) b.active = false; });
    }
    private void button(String label, int x, int y, int w, Runnable action) {
        addRenderableWidget(Button.builder(Component.literal(TextUtil.ellipsize(font, label, w - 8)), b -> action.run())
            .bounds(x, y, w, 20).tooltip(Tooltip.create(Component.literal(label))).build());
    }
    private void changePage(int direction) {
        page = Math.floorMod(page + direction, PersonaDraft.TITLES.length); confirmReload = confirmClose = false; layout();
    }
    private void load() { var payload = new JsonObject(); payload.addProperty("agentId", agentId); send("persona.get", payload); }
    private void send(String action, JsonObject payload) {
        if (busy) return;
        if (!Foreman.connected()) { status = "Нет связи с мостом. Черновик сохранён на экране."; return; }
        busy = true; status = action.equals("persona.save") ? "Сохраняю…" : "Загружаю…"; layout();
        var msg = new JsonObject(); msg.addProperty("action", action); msg.add("payload", payload);
        Foreman.send("studio.action", msg).whenComplete((ack, error) -> Minecraft.getInstance().execute(() -> {
            busy = false;
            if (error != null || !ack.ok()) status = error != null ? "Нет подтверждения от моста. Черновик сохранён." : ack.error();
            else {
                try {
                    draft = new PersonaDraft(ack.result()); confirmReload = confirmClose = false;
                    String notice = ack.result().has("notice") ? ack.result().get("notice").getAsString() : "";
                    status = action.equals("persona.save") ? "Сохранено. Новые фразы — со следующего события." : notice;
                } catch (RuntimeException e) { status = "Не удалось прочитать профиль. Проверь версию моста."; }
            }
            if (Minecraft.getInstance().gui.screen() == this) layout();
        }));
    }
    @Override public boolean keyPressed(KeyEvent event) { return busy || super.keyPressed(event); }
    @Override public boolean charTyped(CharacterEvent event) { return busy || super.charTyped(event); }
    @Override public void onClose() {
        if (busy) return;
        if (draft != null && draft.dirty() && !confirmClose) { confirmClose = true; status = "Есть несохранённые правки. Нажми «Назад» ещё раз, чтобы закрыть."; layout(); return; }
        minecraft.gui.setScreen(parent);
    }
    @Override public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float dt) {
        g.fill(0, 0, width, height, 0xF2292722);
        g.text(font, TextUtil.ellipsize(font, title.getString(), bounds.width()), bounds.x(), 14, 0xFFF2EAD8);
        String hint = page == 0 ? "Описание: 1–2500 символов" : "2–20 фраз · 1 строка = 1 фраза · до 160 символов";
        g.text(font, TextUtil.ellipsize(font, hint, bounds.width()), bounds.x(), 61, 0xFFDFC185);
        var lines = TextUtil.wrapPlain(font, status == null ? "" : status, bounds.width());
        for (int i = 0; i < Math.min(2, lines.size()); i++) g.text(font, TextUtil.ellipsize(font, lines.get(i) + (i == 1 && lines.size() > 2 ? "…" : ""), bounds.width()), bounds.x(), bounds.statusY() + 10 * i, 0xFFDFC185);
        super.extractRenderState(g, mx, my, dt);
        if (my >= bounds.statusY() && status != null && !status.isEmpty()) g.setTooltipForNextFrame(font, Component.literal(status), mx, my);
    }
}
