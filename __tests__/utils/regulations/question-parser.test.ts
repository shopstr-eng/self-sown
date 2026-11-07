import { parseQuestionSlots } from "@/utils/regulations/question-parser";

describe("parseQuestionSlots", () => {
  it("extracts state name, category, and channel", () => {
    expect(
      parseQuestionSlots("Can I sell raw milk in Colorado on my farm?")
    ).toEqual({ state: "CO", category: "raw_milk", channel: "on_farm" });
  });

  it("extracts an uppercase state code", () => {
    expect(
      parseQuestionSlots("Are eggs allowed at a farmers market in TX?")
    ).toEqual({
      state: "TX",
      category: "eggs",
      channel: "farmers_market",
    });
  });

  it("does not resolve lowercase words as state codes", () => {
    const slots = parseQuestionSlots("can I sell jam in my state");
    expect(slots.state).toBeNull();
  });

  it("resolves interstate only from an explicit marker", () => {
    expect(
      parseQuestionSlots("Can I ship cottage food to other states?").channel
    ).toBe("online_interstate");
    expect(
      parseQuestionSlots("Can I sell within my state?").channel
    ).toBe("online_intrastate");
  });

  it("never guesses a channel from bare 'online' or 'ship'", () => {
    expect(
      parseQuestionSlots("Can I sell cottage food online in Texas?").channel
    ).toBeNull();
    expect(
      parseQuestionSlots("Can I ship eggs in Texas?").channel
    ).toBeNull();
  });

  it("treats multiple mentioned states as ambiguous instead of picking one", () => {
    expect(
      parseQuestionSlots("Can I ship raw milk from Texas to Colorado?").state
    ).toBeNull();
  });

  it("never maps generic dairy words to the raw_milk category", () => {
    expect(parseQuestionSlots("Can I sell cheese in Oregon?").category).toBeNull();
    expect(parseQuestionSlots("Is raw milk legal in Oregon?").category).toBe(
      "raw_milk"
    );
  });

  it("returns null slots for questions with no anchors", () => {
    expect(parseQuestionSlots("what is the meaning of life")).toEqual({
      state: null,
      category: null,
      channel: null,
    });
  });

  it("matches state names despite trailing punctuation", () => {
    expect(parseQuestionSlots("Is raw milk legal in Wyoming?").state).toBe("WY");
  });
});
