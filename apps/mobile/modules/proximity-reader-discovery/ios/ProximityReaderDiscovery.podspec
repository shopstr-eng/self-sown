Pod::Spec.new do |s|
  s.name           = 'ProximityReaderDiscovery'
  s.version        = '1.0.0'
  s.summary        = "Presents Apple's ProximityReaderDiscovery Tap to Pay merchant education sheet"
  s.description    = "Local Expo module wrapping ProximityReaderDiscovery (App & Marketing Requirements and Review Guide, Req 4.1). Apple's sheet is the primary merchant-education surface on iOS 18+; callers fall back to the custom education screens on any error."
  s.author         = 'Self Sown'
  s.homepage       = 'https://self-sown.com'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # ProximityReader ships with iOS 15.4+ but ProximityReaderDiscovery is
  # iOS 18+: weak-link so the pod still compiles/loads on older devices,
  # where the #available guard rejects with ERR_UNSUPPORTED_OS.
  s.weak_frameworks = 'ProximityReader'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
