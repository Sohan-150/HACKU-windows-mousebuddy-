// Maps each platform's control types onto our role names, so perception and decisions are platform-neutral.
import type { Role } from "../contracts";

/** Windows UI Automation control types, as Cua's get_window_state reports them (checked on Calculator and Notepad). */
const UIA: Record<string, Role> = {
  Edit: "text field", Document: "text area", ComboBox: "pop-up", ListItem: "list item", List: "other",
  RadioButton: "radio", CheckBox: "checkbox", Button: "button", SplitButton: "button", Hyperlink: "link",
  MenuItem: "menu item", TabItem: "tab", TreeItem: "tree item", Slider: "slider", Spinner: "text field",
  DataItem: "list item", Text: "text", Header: "heading", HeaderItem: "button",
};

/** Cua browser-route snapshot roles (semantic_v2, Chrome/Edge). Checked against recorded snapshots in fixtures/. */
const BROWSER: Record<string, Role> = {
  textbox: "text field", searchbox: "text field", textarea: "text area", combobox: "pop-up", listbox: "pop-up",
  option: "option", radio: "radio", checkbox: "checkbox", switch: "checkbox", button: "button", link: "link",
  menuitem: "menu item", tab: "tab", treeitem: "tree item", slider: "slider", spinbutton: "text field",
  heading: "heading", statictext: "text", paragraph: "text",
};

/** macOS accessibility roles (Safari and AppKit apps). */
const AX: Record<string, Role> = {
  AXTextField: "text field", AXSearchField: "text field", AXTextArea: "text area", AXComboBox: "pop-up",
  AXPopUpButton: "pop-up", AXMenuItem: "menu item", AXRadioButton: "radio", AXCheckBox: "checkbox",
  AXButton: "button", AXLink: "link", AXTab: "tab", AXRow: "list item", AXCell: "list item", AXSlider: "slider",
  AXHeading: "heading", AXStaticText: "text",
};

export const uiaRole = (raw?: string): Role => (raw && UIA[raw]) || "other";
export const browserRole = (raw?: string): Role => (raw && BROWSER[raw.toLowerCase()]) || "other";
export const axRole = (raw?: string): Role => (raw && AX[raw]) || "other";
