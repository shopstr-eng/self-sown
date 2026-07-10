import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import MilkMarketSwitch from "../mm-switch";

const mockUseTheme = { theme: "light" };
jest.mock("next-themes", () => ({
  useTheme: () => mockUseTheme,
}));

const mockRouterPush = jest.fn();
jest.mock("next/router", () => ({
  useRouter: () => ({
    push: mockRouterPush,
  }),
}));

jest.mock("@heroui/react", () => ({
  Switch: (props: {
    onValueChange: (value: boolean) => void;
    isSelected: boolean;
    classNames?: { wrapper?: string };
  }) => (
    <button
      role="switch"
      onClick={() => props.onValueChange(!props.isSelected)}
      data-wrapper-class={props.classNames?.wrapper}
    />
  ),
}));

describe("MilkMarketSwitch", () => {
  const mockSetWotFilter = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseTheme.theme = "light";
  });

  it("should call setWotFilter with the inverted value when clicked", () => {
    render(
      <MilkMarketSwitch wotFilter={false} setWotFilter={mockSetWotFilter} />
    );
    const switchControl = screen.getByRole("switch");

    fireEvent.click(switchControl);

    expect(mockSetWotFilter).toHaveBeenCalledWith(true);
  });

  it("should call router.push when the 'Trust' label is clicked", () => {
    render(
      <MilkMarketSwitch wotFilter={false} setWotFilter={mockSetWotFilter} />
    );
    const trustLabel = screen.getByText("Trust");

    fireEvent.click(trustLabel);

    expect(mockRouterPush).toHaveBeenCalledWith("/settings/account");
  });

  it("applies the primary-yellow selected wrapper styling", () => {
    render(
      <MilkMarketSwitch wotFilter={false} setWotFilter={mockSetWotFilter} />
    );

    const switchControl = screen.getByRole("switch");

    expect(switchControl).toHaveAttribute(
      "data-wrapper-class",
      "bg-gray-300 group-data-[selected=true]:bg-primary-yellow"
    );
  });
});
