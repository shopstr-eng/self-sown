import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import MilkMarketSpinner from "../mm-spinner";
import { useTheme } from "next-themes";

jest.mock("next-themes", () => ({
  useTheme: jest.fn(),
}));

jest.mock("@heroui/react", () => ({
  Spinner: (props: { classNames?: { circle1?: string }; size: string }) => (
    <div
      data-testid="spinner"
      data-circle-class={props.classNames?.circle1}
    ></div>
  ),
}));

const mockedUseTheme = useTheme as jest.Mock;

describe("MilkMarketSpinner", () => {
  it("renders with the primary-yellow spinner styling", () => {
    mockedUseTheme.mockReturnValue({ theme: "light" });

    render(<MilkMarketSpinner />);

    const spinner = screen.getByTestId("spinner");
    expect(spinner).toHaveAttribute(
      "data-circle-class",
      "border-b-primary-yellow"
    );
  });
});
