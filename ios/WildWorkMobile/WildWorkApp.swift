import SwiftUI

@main
struct WildWorkApp: App {
    @StateObject private var store = ServerStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .preferredColorScheme(nil)
        }
    }
}
