import SwiftUI

/// Matches the web ProjectBadge hash, OKLCH palette, and light/dark colors.
struct ProjectChip: View {
    let name: String
    @Environment(\.colorScheme) private var colorScheme

    static func hue(for name: String) -> Double {
        let hues: [Double] = [25, 50, 85, 110, 130, 150, 175, 200, 225, 255, 280, 305, 330, 355]
        var hash: UInt32 = 0
        for unit in name.utf16 { hash = (hash &* 31) &+ UInt32(unit) }
        hash ^= hash >> 16
        hash = hash &* 0x7feb352d
        hash ^= hash >> 15
        hash = hash &* 0x846ca68b
        hash ^= hash >> 16
        return hues[Int(hash % UInt32(hues.count))]
    }

    private func color(_ lightness: Double, _ chroma: Double) -> Color {
        let angle = Self.hue(for: name) * .pi / 180
        let a = chroma * cos(angle), b = chroma * sin(angle)
        let l = pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m = pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3)
        let s = pow(lightness - 0.0894841775 * a - 1.2914855480 * b, 3)
        return Color(.sRGBLinear,
                     red: max(0, min(1, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
                     green: max(0, min(1, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
                     blue: max(0, min(1, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)))
    }

    var body: some View {
        let dark = colorScheme == .dark
        Text(name).font(.caption.weight(.medium))
            .lineLimit(1).padding(.horizontal, 6).padding(.vertical, 2)
            .foregroundStyle(color(dark ? 0.85 : 0.50, dark ? 0.07 : 0.13))
            .background(color(0.70, 0.12).opacity(dark ? 0.22 : 0.18), in: Capsule())
            .accessibilityLabel("Project \(name)")
    }
}
