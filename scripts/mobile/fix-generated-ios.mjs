// Expo's generated bundle command needs quoting when linked dependencies live
// under a path containing spaces. Only touch the supplied generated project.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const ios = process.argv[2];
if (!ios) throw new Error("Supply the generated ios directory.");
for (const project of ["SelfsownVendor.xcodeproj", "Pods/Pods.xcodeproj"]) {
  const file = join(ios, project, "project.pbxproj");
  const source = readFileSync(file, "utf8");
  const result = source.replace(
    /(shellScript = )("(?:\\.|[^"\\])*")(;)/g,
    (match, before, encoded, after) => {
      const script = JSON.parse(encoded);
      const fixed = script
        .replace(
          'bash -l -c "$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh"',
          'bash "$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh"'
        )
        .replace(/^(`.*react-native-xcode\.sh.*`)$/gm, '"$1"');
      return before + JSON.stringify(fixed) + after;
    }
  );
  writeFileSync(file, result);
}
