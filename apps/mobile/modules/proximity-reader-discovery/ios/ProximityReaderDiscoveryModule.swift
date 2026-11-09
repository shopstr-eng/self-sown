import ExpoModulesCore
import ProximityReader

// Apple's own Tap to Pay on iPhone merchant education (App & Marketing
// Requirements and Review Guide, Req 4.1 — Required on iOS 18+). The Stripe
// Terminal RN SDK (beta.34) does not expose ProximityReaderDiscovery; the
// guide explicitly allows integrating it directly alongside the PSP SDK, and
// Apple's entitlement review (Nov 2026) required it. Using Apple's sheet
// fulfills 4.4/4.6/4.7/4.8 because Apple owns the content, localization, and
// currency of the material.
public class ProximityReaderDiscoveryModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ProximityReaderDiscovery")

    // Resolves when the merchant dismisses Apple's education sheet. Rejects
    // on iOS <18, a missing view controller, or any content/presentation
    // error — the JS caller treats any rejection as "show the custom
    // education screens instead", so a failure here never skips education.
    AsyncFunction("presentEducation") { (promise: Promise) in
      guard #available(iOS 18.0, *) else {
        promise.reject(
          "ERR_UNSUPPORTED_OS",
          "ProximityReaderDiscovery requires iOS 18.0 or later."
        )
        return
      }
      Task { @MainActor in
        guard let presenter = self.appContext?.utilities?.currentViewController() else {
          promise.reject(
            "ERR_NO_PRESENTER",
            "No view controller available to present the education sheet from."
          )
          return
        }
        do {
          let discovery = ProximityReaderDiscovery()
          let content = try await discovery.content(for: .payment(.howToTap))
          try await discovery.presentContent(content, from: presenter)
          promise.resolve(nil)
        } catch {
          promise.reject("ERR_PRESENTATION", error.localizedDescription)
        }
      }
    }
  }
}
