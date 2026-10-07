package dev.agentcraft.client.studio;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agentcraft.block.ModBlocks;
import dev.agentcraft.client.agents.AgentSkins;
import dev.agentcraft.client.agents.ClientAgentEntity;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.world.StationInteractions;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.network.chat.Component;

/** Shared command-desk and planning-desk UI; mutations always wait for an acknowledgement. */
public final class StudioScreen extends Screen {
    private static final String[] TABS = {"Команда", "Внешность", "План", "Очередь", "Места", "Память", "Настройки"};
    private static final String[] ROLES = {"desk", "library", "testbench", "terminal", "mergestation", "meeting", "lounge", "user"};
    private static final String[] ROLE_NAMES = {"Стол", "Чтение", "Проверки", "Терминал", "Ревью", "Планирование", "Отдых", "Общение"};
    private JsonObject data = new JsonObject();
    private int tab, page, x, y, w, h, top, role;
    private String agent = "marlow", status = "Подключаю пульт…";
    private String openTask;
    private Screen taskReturn;
    private int restIndex;
    private boolean busy;
    private int pollTicks;
    private StudioPreferences.Look draft;
    private String draftSkin;
    private String draftColor;
    private ClientAgentEntity preview;
    private final List<Label> labels = new ArrayList<>();
    private final boolean planningOnly;
    private record Label(String text, int x, int y, int width) {}
    public StudioScreen() { this(false); }
    private StudioScreen(boolean planningOnly) {
        super(planningOnly ? Component.translatable("block.agentcraft.planning_desk") : Component.literal("Пульт AgentCraft"));
        this.planningOnly = planningOnly;
        if (planningOnly) { tab = 2; status = "Загружаю план…"; }
    }
    public static StudioScreen planningDesk() { return new StudioScreen(true); }
    public StudioScreen(String taskId) { this(); openTask = taskId; tab = 3; }
    public StudioScreen(String taskId, Screen parent) { this(taskId); taskReturn = parent; }
    public static boolean gathering() {
        var screen = Minecraft.getInstance().gui.screen();
        if (screen instanceof StudioScreen studio) return studio.tab == 2;
        if (screen instanceof Form form && form.parent instanceof StudioScreen studio) return studio.tab == 2;
        if (screen instanceof TaskDetails details) return details.parent.tab == 2;
        return false;
    }
    public static void initFeature() {
        StationInteractions.onUse(ModBlocks.COMMAND_DESK, (p, pos, state, be) -> Minecraft.getInstance().gui.setScreen(new StudioScreen()));
        StationInteractions.onUse(ModBlocks.PLANNING_DESK, (p, pos, state, be) -> Minecraft.getInstance().gui.setScreen(planningDesk()));
        dev.agentcraft.client.dev.DevBridge.registerScreen("studio", mc -> new StudioScreen());
        dev.agentcraft.client.dev.DevBridge.registerScreen("planning", mc -> planningDesk());
    }
    @Override public boolean isPauseScreen() { return false; }
    @Override public void onClose() { minecraft.gui.setScreen(taskReturn); }
    @Override public void tick() { super.tick(); if (++pollTicks >= 60) { pollTicks = 0; if (!busy && (tab == 2 || tab == 3) && Foreman.connected()) request("get", new JsonObject(), null); } }
    @Override public void extractBackground(GuiGraphicsExtractor g, int mx, int my, float dt) {}
    @Override protected void init() { layout(); if (!data.has("version") && !busy) request("get", new JsonObject(), null); }
    private static String str(JsonObject o, String key) { return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : ""; }
    private static boolean flag(JsonObject o, String key) { return o.has(key) && o.get(key).getAsBoolean(); }
    private JsonArray array(String key) { return data.has(key) ? data.getAsJsonArray(key) : new JsonArray(); }
    private JsonObject profile() {
        for (var value : array("profiles")) if (str(value.getAsJsonObject(), "id").equals(agent)) return value.getAsJsonObject();
        return new JsonObject();
    }
    private void request(String action, JsonObject payload, Runnable after) {
        if (busy) return;
        busy = true; status = "Выполняю…";
        children().forEach(c -> { if (c instanceof net.minecraft.client.gui.components.AbstractWidget b) b.active = false; });
        if (!Foreman.connected()) { busy = false; status = "Нет связи с мостом. Запусти Start-Bridge."; layout(); return; }
        JsonObject msg = new JsonObject(); msg.addProperty("action", action); msg.add("payload", payload);
        Foreman.send("studio.action", msg).whenComplete((ack, error) -> Minecraft.getInstance().execute(() -> {
            busy = false;
            if (error != null || !ack.ok()) status = error != null ? error.getMessage() : ack.error();
            else { data = ack.result() == null ? new JsonObject() : ack.result(); status = action.equals("get") || action.equals("claude-login") ? str(data, "notice") : "Сохранено";
                try { if (after != null) after.run(); } catch (Exception e) { status = e.getMessage(); }
            }
            if (Minecraft.getInstance().gui.screen() == this) layout();
            if (openTask != null && data.has("version") && Minecraft.getInstance().gui.screen() == this) {
                String id = openTask; openTask = null;
                for (var value : array("items")) if (str(value.getAsJsonObject(), "id").equals(id)) { taskDetails(value.getAsJsonObject()); break; }
            }
        }));
    }
    private Button button(String label, int bx, int by, int bw, Runnable run) {
        Button b = Button.builder(Component.literal(TextUtil.ellipsize(font, label, bw - 10)), p -> {
            try { run.run(); } catch (Exception e) { status = e.getMessage(); }
        }).bounds(bx, by, bw, 20).tooltip(Tooltip.create(Component.literal(label))).build();
        b.active = !busy; return addRenderableWidget(b);
    }
    private void label(String text, int lx, int ly, int width) { labels.add(new Label(text, lx, ly, width)); }
    private EditBox input(String hint, String value, int ix, int iy, int iw, int max) {
        EditBox e = new EditBox(font, ix, iy, iw, 20, Component.literal(hint)); e.setMaxLength(max); e.setValue(value); e.setHint(Component.literal(hint));
        return addRenderableWidget(e);
    }
    private void selectAgent() {
        button(agent.equals("marlow") ? "Агент: Codex" : "Агент: Claude", x + 12, top, 145, () -> { agent = agent.equals("marlow") ? "wren" : "marlow"; draft = null; layout(); });
    }
    private void layout() {
        clearWidgets(); labels.clear(); preview = null;
        w = Math.min(650, width - 16); h = Math.min(440, height - 16); x = (width - w) / 2; y = (height - h) / 2; top = y + (planningOnly ? 57 : 78);
        if (planningOnly) {
            label("Общий план проекта · те же карточки, что в пульте", x + 12, y + 34, w - 120);
        } else {
            for (int i = 0; i < TABS.length; i++) {
                final int n = i; int bw = (w - 24) / 4;
                button(TABS[i], x + 12 + (i % 4) * bw, y + 28 + (i / 4) * 23, bw - 3, () -> { tab = n; page = 0; draft = null; layout(); });
            }
        }
        button("Обновить", x + w - 96, y + (planningOnly ? 28 : 51), 84, () -> request("get", new JsonObject(), null));
        if (!data.has("version")) {
            if (tab == 6) speechChatSetting(x + 12, top, w - 24);
            return;
        }
        switch (tab) {
            case 0 -> team(); case 1 -> appearance(); case 2, 3 -> tasks(); case 4 -> places(); case 5 -> memory(); case 6 -> settings();
        }
    }
    private void team() {
        selectAgent(); var p = profile();
        int left = x + 12, cy = top + 28, bw = Math.min(230, w - 24);
        label("Имя персонажа", left, cy, bw);
        EditBox name = input("Имя", str(p, "name"), left, cy + 12, bw, 28);
        button("Сохранить имя", left + bw + 6, cy + 12, Math.max(90, w - bw - 30), () -> {
            JsonObject next = p.deepCopy(); next.addProperty("name", name.getValue()); request("agent", next, null);
        });
        button(flag(p, "enabled") ? "Убрать исполнителя из команды" : "Добавить исполнителя в команду", left, cy + 39, w - 24, () -> {
            JsonObject next = p.deepCopy(); next.addProperty("enabled", !flag(p, "enabled")); request("agent", next, null);
        });
        button(flag(p, "visible") ? "Персонаж в мире: виден" : "Персонаж в мире: скрыт", left, cy + 63, w - 24, () -> {
            JsonObject next = p.deepCopy(); next.addProperty("visible", !flag(p, "visible")); request("agent", next, null);
        });
        label(agent.equals("marlow") ? "Codex выполняет задачи в подключённом чате." : "Claude Code проверяет зафиксированную версию изменений.", left, cy + 90, w - 24);
        label("Скрытие персонажа не отключает исполнителя.", left, cy + 103, w - 24);
    }
    private void appearance() {
        selectAgent(); var p = profile();
        if (draft == null) { draft = StudioPreferences.get().look(agent).copy(); draftSkin = str(p, "skin"); draftColor = str(p, "color"); }
        int left = x + 12, cy = top + 26, bw = Math.max(150, (w - 32) * 2 / 3), row = 23;
        button("Скин: " + Component.translatableWithFallback("skin.agentcraft." + draftSkin, draftSkin).getString(), left, cy, bw, () -> {
            var skins = array("skins"); int found = 0; for (int i = 0; i < skins.size(); i++) if (skins.get(i).getAsString().equals(draftSkin)) found = i;
            if (!skins.isEmpty()) draftSkin = skins.get((found + 1) % skins.size()).getAsString(); draft.png = ""; layout();
        });
        button(draft.slim ? "Руки: тонкие" : "Руки: обычные", left, cy + row, bw / 2 - 2, () -> { draft.slim = !draft.slim; layout(); });
        button(draft.hideLayer ? "Внешний слой: выкл." : "Внешний слой: вкл.", left + bw / 2 + 2, cy + row, bw / 2 - 2, () -> { draft.hideLayer = !draft.hideLayer; layout(); });
        button("Подписи…", left, cy + row * 2, bw / 2 - 2, () -> Minecraft.getInstance().gui.setScreen(new LookScreen(this, draft)));
        button("Загрузить PNG…", left + bw / 2 + 2, cy + row * 2, bw / 2 - 2, () -> {
            var edit = new Form(this, "Свой скин PNG 64×64", List.of("Полный путь к PNG"), List.of(""), values -> {
                try { draft.png = AgentSkins.importPng(values.get(0)); Minecraft.getInstance().gui.setScreen(this); }
                catch (Exception e) { throw new IllegalArgumentException(e.getMessage()); }
            }); Minecraft.getInstance().gui.setScreen(edit);
        });
        EditBox color = input("Цвет #RRGGBB", draftColor, left, cy + row * 3, bw, 7); color.setResponder(value -> draftColor = value);
        button("Применить", left, cy + row * 4, bw / 2 - 2, () -> {
            JsonObject next = p.deepCopy(); next.addProperty("skin", draftSkin); next.addProperty("color", color.getValue());
            request("agent", next, () -> { StudioPreferences.get().looks.put(agent, draft.copy()); StudioPreferences.get().save(); });
        });
        button("Стандартный вид", left + bw / 2 + 2, cy + row * 4, bw / 2 - 2, () -> { draft = StudioPreferences.defaults(agent); draftSkin = agent; draftColor = agent.equals("marlow") ? "#858ED1" : "#D78E65"; layout(); });
        if (minecraft.level != null) { preview = new ClientAgentEntity(minecraft.level, agent, AgentSkins.preview(agent, draftSkin, draft)); preview.previewLook = draft;
            preview.view().name = draft.hideName ? "" : str(p, "name");
            if (!draft.hideRole) preview.view().name += (preview.view().name.isEmpty() ? "" : " · ") + (agent.equals("marlow") ? "Разработчик" : "Ревьюер");
            preview.view().nameColor = 0xFF000000 | dev.agentcraft.Cast.parseColor(draftColor, 0xDFC185);
        }
    }
    private List<JsonObject> visibleTasks() {
        List<JsonObject> out = new ArrayList<>();
        for (var v : array("items")) { JsonObject i = v.getAsJsonObject(); if (tab == 2 || !str(i, "stage").equals("plan")) out.add(i); }
        return out;
    }
    private void tasks() {
        int left = x + 12, cy = top, bw = (w - 30) / 4;
        if (tab == 2) {
            button("Новая задача", left, cy, bw * 2, () -> taskForm(null));
            button("Обсудить план", left + bw * 2 + 4, cy, w - bw * 2 - 28, () -> request("plan", new JsonObject(), () -> minecraft.gui.setScreen(new dev.agentcraft.client.console.ConsoleScreen("@Claude Обсудим план. Помоги уточнить задачи и ожидаемый результат. Когда попрошу добавить их на доску, создай черновики; согласую и запущу их я. Моя идея: "))));
        } else {
            String[] names = {"Начать / продолжить", "Пауза", "Стоп", "Планирование"}; String[] ops = {"start", "pause", "stop", "plan"};
            for (int n = 0; n < 4; n++) { final String op = ops[n]; button(names[n], left + n * (bw + 2), cy, bw, () -> request(op, new JsonObject(), null)); }
        }
        cy += 26;
        var list = visibleTasks(); int count = Math.max(1, (y + h - 50 - cy) / 25); page = Math.min(page, Math.max(0, (list.size() - 1) / count));
        for (int n = page * count; n < Math.min(list.size(), (page + 1) * count); n++) {
            var item = list.get(n); button(str(item, "id") + " · " + stage(str(item, "stage")) + " · " + str(item, "title"), left, cy, w - 24, () -> taskDetails(item)); cy += 25;
        }
        if (list.isEmpty()) label("Пул пуст. Добавь задачу во вкладке «План».", left, cy + 3, w - 24);
        button("←", left, y + h - 44, 30, () -> { page = Math.max(0, page - 1); layout(); });
        button("→", left + 34, y + h - 44, 30, () -> { page++; layout(); });
        int questions = Foreman.state().openDecisions().size();
        button("Вопросы: " + questions, x + w - 154, y + h - 44, 142, () -> minecraft.gui.setScreen(new dev.agentcraft.client.decisions.DecisionScreen(null, this)));
    }
    private static String stage(String s) { return switch (s) { case "plan" -> "План"; case "queued" -> "В очереди"; case "coding" -> "В работе"; case "review" -> "Ревью"; case "question" -> "Нужно решение"; case "done" -> "Готово"; case "cancelled" -> "Отменена"; default -> s; }; }
    private void taskForm(JsonObject item) {
        String deps = item == null ? "" : item.getAsJsonArray("deps").toString().replaceAll("[\\[\\]\"]", "");
        List<String> values = item == null ? List.of("", "", "", "", "0") : List.of(str(item, "title"), str(item, "description"), str(item, "expected"), deps, str(item, "priority"));
        minecraft.gui.setScreen(new Form(this, item == null ? "Новая задача" : "Редактировать задачу", List.of("Название", "Описание", "Ожидаемый результат", "Зависимости: t1,t2 (необязательно)", "Приоритет: 0–100"), values, v -> {
            JsonObject p = new JsonObject(); p.addProperty("title", v.get(0)); p.addProperty("description", v.get(1)); p.addProperty("expected", v.get(2)); p.addProperty("priority", Integer.parseInt(v.get(4)));
            JsonArray a = new JsonArray(); for (String id : v.get(3).split(",")) if (!id.isBlank()) a.add(id.trim()); p.add("deps", a);
            if (item != null) p.addProperty("id", str(item, "id"));
            minecraft.gui.setScreen(this); request(item == null ? "create" : "edit", p, null);
        }));
    }
    private void taskDetails(JsonObject item) {
        String content = str(item, "title") + "\n\n" + stage(str(item, "stage")) + " · " + str(item, "project") + "\n\n" + str(item, "description") + "\n\nОжидается:\n" + str(item, "expected")
            + "\n\nПроверки:\n" + str(item, "checks") + "\n\nРезультат:\n" + str(item, "summary") + "\n\nРевью Claude:\n" + str(item, "review") + "\n\n" + str(item, "blockedReason");
        minecraft.gui.setScreen(new TaskDetails(this, item, content));
    }
    private void places() {
        selectAgent(); int left = x + 12, cy = top + 28;
        button("Место: " + ROLE_NAMES[role], left, cy, w - 24, () -> { role = (role + 1) % ROLES.length; layout(); });
        if (ROLES[role].equals("lounge")) {
            restPlaces(left, cy + 25);
            return;
        }
        button("Назначить там, где я стою", left, cy + 27, w - 24, () -> { StudioPreferences.get().mark(agent, ROLES[role]); status = "Место сохранено для " + agent; });
        button("Убрать отдельное место", left, cy + 54, w - 24, () -> { StudioPreferences.get().remove(agent, ROLES[role]); status = "Используется общее место"; });
        label("Сначала отметь основной участок Настройщиком.", left, cy + 82, w - 24);
        label("Пульт можно открыть, стоя на будущем месте агента.", left, cy + 95, w - 24);
    }
    private void restPlaces(int left, int cy) {
        var prefs = StudioPreferences.get(); var points = prefs.rest(agent);
        restIndex = points.isEmpty() ? 0 : Math.min(restIndex, points.size() - 1);
        var selected = points.isEmpty() ? null : points.get(restIndex);
        String text = selected == null ? "Места отдыха ещё не назначены" : (restIndex + 1) + "/" + points.size()
            + " · " + (selected.dance() ? "Танцы у шеста" : "Обычный отдых") + " · " + selected.anchor().blockPos().toShortString();
        button(text, left, cy, w - 24, () -> { if (!points.isEmpty()) restIndex = (restIndex + 1) % points.size(); layout(); });
        button("Добавить отдых там, где я стою", left, cy + 23, (w - 28) / 2, () -> { prefs.mark(agent, "lounge"); status = "Место отдыха добавлено"; layout(); });
        button("Добавить танцы Настройщиком", left + (w - 28) / 2 + 4, cy + 23, (w - 28) / 2,
            () -> ConfiguratorClient.restPlacement(agent, true, null));
        button("Перенести выбранное место", left, cy + 46, (w - 28) / 2, () -> {
            if (selected == null) return;
            ConfiguratorClient.restPlacement(agent, selected.dance(), selected.id());
        });
        button("Удалить выбранное", left + (w - 28) / 2 + 4, cy + 46, (w - 28) / 2, () -> {
            if (selected != null) prefs.removeRest(agent, selected.id()); status = "Место удалено"; layout();
        });
        if (h >= 290) {
            label("Для танцев: шест 3 блока, свободная площадка 3×3.", left, cy + 76, w - 24);
            label("Проигрыватель с играющей пластинкой — не дальше 5 блоков.", left, cy + 89, w - 24);
        }
    }
    private void memory() {
        int left = x + 12;
        button("Открыть библиотеку", left, top, w - 24, () -> minecraft.gui.setScreen(new dev.agentcraft.client.library.LibraryScreen(null, null)));
        button("Сохранить общую заметку", left, top + 28, w - 24, () -> minecraft.gui.setScreen(new Form(this, "Общая заметка проекта", List.of("Название", "Текст"), List.of("", ""), values -> {
            JsonObject p = new JsonObject(); p.addProperty("title", values.get(0)); p.addProperty("body", values.get(1)); p.addProperty("scope", "shared"); minecraft.gui.setScreen(this); request("note", p, null);
        })));
        label("Общие записи передаются разработчику и ревьюеру.", left, top + 62, w - 24);
        label("Заключения Claude сохраняются в библиотеке с версией кода.", left, top + 76, w - 24);
    }
    private void speechChatSetting(int left, int cy, int width) {
        var preferences = StudioPreferences.get();
        var toggle = button("Реплики в чате: " + (preferences.speechInMinecraftChat ? "вкл." : "выкл."), left, cy, width, () -> {
            preferences.setSpeechInMinecraftChat(!preferences.speechInMinecraftChat);
            status = "Сохранено на этом компьютере";
            layout();
        });
        toggle.active = true; // a local option also works without a bridge connection
    }
    private void settings() {
        int left = x + 12; String mode = str(data, "reviewMode");
        int half = (w - 28) / 2;
        button("Ревью: " + (mode.equals("auto") ? "автоматически" : mode.equals("manual") ? "по кнопке" : "выключено"), left, top, half, () -> {
            JsonObject p = new JsonObject(); p.addProperty("reviewMode", mode.equals("auto") ? "manual" : mode.equals("manual") ? "off" : "auto"); p.addProperty("claudePath", str(data, "claudePath")); request("settings", p, null);
        });
        speechChatSetting(left + half + 4, top, half);
        label("Claude Code: " + (flag(data, "claudeFound") ? str(data, "claudeAuth") : "укажи путь к claude.exe"), left, top + 29, w - 24);
        EditBox exe = input("Полный путь к claude.exe", str(data, "claudePath"), left, top + 43, w - 24, 1000);
        button("Сохранить путь", left, top + 68, (w - 28) / 2, () -> { JsonObject p = new JsonObject(); p.addProperty("reviewMode", mode); p.addProperty("claudePath", exe.getValue()); request("settings", p, null); });
        button("Войти / проверить вход", left + (w - 28) / 2 + 4, top + 68, (w - 28) / 2, () -> request("claude-login", new JsonObject(), null));
        label("Проект: " + str(data, "repo"), left, top + 96, w - 24);
        label("Подключение Codex: " + str(data, "chat"), left, top + 110, w - 24);
    }
    @Override public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float dt) {
        g.fill(x, y, x + w, y + h, 0xF22B2925); g.fill(x, y, x + w, y + 2, 0xFFBC984B);
        g.text(font, TextUtil.ellipsize(font, title.getString() + " · " + switch (str(data, "mode")) { case "running" -> "Выполнение"; case "paused" -> "Пауза"; default -> "Планирование"; }, w - 24), x + 12, y + 11, 0xFFF2EAD8);
        for (Label l : labels) g.text(font, TextUtil.ellipsize(font, l.text(), l.width()), l.x(), l.y(), 0xFFD5CEC0);
        if (preview != null) {
            int px = x + 24 + Math.max(150, (w - 32) * 2 / 3);
            InventoryScreen.extractEntityInInventoryFollowsMouse(g, px, top + 27, x + w - 12, y + h - 28, Math.max(20, Math.min(65, (h - 135) / 2)), 0.0625f, mx, my, preview);
        }
        g.text(font, TextUtil.ellipsize(font, status == null ? "" : status, w - 24), x + 12, y + h - 16, 0xFFDFC185);
        super.extractRenderState(g, mx, my, dt);
    }

    /** One field at a time: long descriptions remain usable at large Minecraft GUI scales. */
    private static class Form extends Screen {
        final Screen parent; final List<String> names; final List<String> values; final Consumer<List<String>> save; int step; MultiLineEditBox field; String error = "";
        Form(Screen parent, String title, List<String> names, List<String> values, Consumer<List<String>> save) { super(Component.literal(title)); this.parent = parent; this.names = names; this.values = new ArrayList<>(values); this.save = save; }
        @Override public boolean isPauseScreen() { return false; }
        @Override protected void init() {
            clearWidgets(); int w = Math.min(550, width - 32), x = (width - w) / 2;
            field = addRenderableWidget(MultiLineEditBox.builder().setX(x).setY(58).setPlaceholder(Component.literal(names.get(step))).build(font, w, Math.max(35, height - 112), Component.literal(names.get(step))));
            field.setCharacterLimit(names.get(step).equals("Описание") ? 3000 : names.get(step).equals("Ожидаемый результат") ? 1500 : 6000); field.setValue(values.get(step));
            final int fieldStep = step; field.setValueListener(value -> values.set(fieldStep, value));
            addRenderableWidget(Button.builder(Component.literal(step == 0 ? "Отмена" : "Назад"), b -> { values.set(step, field.getValue()); if (step == 0) onClose(); else { step--; init(); } }).bounds(x, height - 43, w / 2 - 3, 20).build());
            addRenderableWidget(Button.builder(Component.literal(step == names.size() - 1 ? "Сохранить" : "Далее"), b -> {
                values.set(step, field.getValue()); if (step < names.size() - 1) { step++; init(); } else try { save.accept(values); } catch (Exception e) { error = e.getMessage(); }
            }).bounds(x + w / 2 + 3, height - 43, w / 2 - 3, 20).build());
        }
        @Override public void onClose() { minecraft.gui.setScreen(parent); }
        @Override public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float dt) {
            g.fill(0, 0, width, height, 0xEF292722); g.text(font, title, 16, 15, 0xFFF2EAD8); g.text(font, (step + 1) + "/" + names.size() + " · " + names.get(step), 16, 36, 0xFFDFC185);
            g.text(font, TextUtil.ellipsize(font, error, width - 32), 16, height - 17, 0xFFFFA08A); super.extractRenderState(g, mx, my, dt);
        }
    }
    private static class LookScreen extends Screen {
        final StudioScreen parent; final StudioPreferences.Look look;
        LookScreen(StudioScreen parent, StudioPreferences.Look look) { super(Component.literal("Подписи персонажа")); this.parent = parent; this.look = look; }
        @Override public boolean isPauseScreen() { return false; }
        @Override protected void init() {
            clearWidgets(); int x = Math.max(10, (width - 250) / 2), y = Math.max(30, (height - 100) / 2);
            addRenderableWidget(Button.builder(Component.literal("Имя: " + (look.hideName ? "скрыто" : "видно")), b -> { look.hideName = !look.hideName; init(); }).bounds(x, y, 250, 20).build());
            addRenderableWidget(Button.builder(Component.literal("Роль: " + (look.hideRole ? "скрыта" : "видна")), b -> { look.hideRole = !look.hideRole; init(); }).bounds(x, y + 25, 250, 20).build());
            addRenderableWidget(Button.builder(Component.literal("Текст состояния: " + (look.hideStatus ? "скрыт" : "виден")), b -> { look.hideStatus = !look.hideStatus; init(); }).bounds(x, y + 50, 250, 20).build());
            addRenderableWidget(Button.builder(Component.literal("Назад к предпросмотру"), b -> onClose()).bounds(x, y + 75, 250, 20).build());
        }
        @Override public void onClose() { minecraft.gui.setScreen(parent); }
    }
    private static class TaskDetails extends Screen {
        final StudioScreen parent; final JsonObject item; final String content;
        TaskDetails(StudioScreen parent, JsonObject item, String content) { super(Component.literal(str(item, "id") + " · " + str(item, "title"))); this.parent = parent; this.item = item; this.content = content; }
        @Override public boolean isPauseScreen() { return false; }
        @Override protected void init() {
            int w = Math.min(620, width - 24), x = (width - w) / 2;
            var body = addRenderableWidget(MultiLineEditBox.builder().setX(x).setY(36).build(font, w, Math.max(40, height - 108), Component.literal("Описание задачи"))); body.setValue(content);
            body.setValueListener(value -> { if (!value.equals(content)) body.setValue(content); });
            String stage = str(item, "stage"); List<String> ops = new ArrayList<>(); List<String> labels = new ArrayList<>();
            if (stage.equals("plan")) { ops.add("approve"); labels.add("В очередь"); }
            if (stage.equals("plan") || stage.equals("queued")) { ops.add("edit"); labels.add("Изменить"); }
            if (stage.equals("review")) { ops.add("review"); labels.add("Ревью Claude"); }
            if (stage.equals("question")) { ops.add("retry"); labels.add("Повторить"); ops.add("question"); labels.add("Ответить"); }
            if (!stage.equals("done") && !stage.equals("cancelled")) { ops.add("cancel"); labels.add("Отменить"); }
            ops.add("back"); labels.add("Назад"); int bw = w / ops.size();
            for (int i = 0; i < ops.size(); i++) { String op = ops.get(i);
                addRenderableWidget(Button.builder(Component.literal(TextUtil.ellipsize(font, labels.get(i), bw - 10)), b -> {
                    if (op.equals("edit")) parent.taskForm(item);
                    else if (op.equals("question")) { var d = Foreman.state().openDecisions().stream().filter(q -> str(item, "id").equals(q.taskId())).findFirst(); minecraft.gui.setScreen(new dev.agentcraft.client.decisions.DecisionScreen(d.map(q -> q.id()).orElse(null), this)); }
                    else if (op.equals("back")) onClose();
                    else { minecraft.gui.setScreen(parent); JsonObject p = new JsonObject(); p.addProperty("id", str(item, "id")); parent.request(op, p, null); }
                }).bounds(x + i * bw, height - 57, bw - 3, 20).build());
            }
        }
        @Override public void onClose() { minecraft.gui.setScreen(parent.taskReturn == null ? parent : parent.taskReturn); }
        @Override public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float dt) { g.fill(0, 0, width, height, 0xEF292722); g.text(font, TextUtil.ellipsize(font, title.getString(), width - 24), 12, 15, 0xFFF2EAD8); super.extractRenderState(g, mx, my, dt); }
    }
}
