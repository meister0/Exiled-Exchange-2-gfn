import Foundation
import Vision
import AppKit

// Apple Vision Framework OCR helper.
// Usage: avf-ocr [png-file-path]
//   If no path given, reads PNG from stdin.
// Output: JSON array of recognized text observations to stdout.
// Each observation: { "text": "...", "confidence": 0.95, "bbox": { "x": 0, "y": 0, "w": 100, "h": 20 } }
// Bounding box is in pixel coordinates, origin top-left.

struct TextObservation: Codable {
    let text: String
    let confidence: Float
    let bbox: BBox
}

struct BBox: Codable {
    let x: Int
    let y: Int
    let w: Int
    let h: Int
}

let nonFlagArgs = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("--") }
let imageData: Data
if let filePath = nonFlagArgs.first {
    // Read from file
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: filePath)) else {
        fputs("Error: cannot read file at \(filePath)\n", stderr)
        exit(1)
    }
    imageData = data
} else {
    // Read from stdin
    imageData = FileHandle.standardInput.readDataToEndOfFile()
}

guard let image = NSImage(data: imageData) else {
    fputs("Error: cannot decode image data\n", stderr)
    exit(1)
}

guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("Error: cannot convert to CGImage\n", stderr)
    exit(1)
}

let imageWidth = cgImage.width
let imageHeight = cgImage.height

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false  // PoE2 text is game-specific, correction hurts
request.recognitionLanguages = ["en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

guard let results = request.results else {
    print("[]")
    exit(0)
}

var observations: [TextObservation] = []

for observation in results {
    let text = observation.topCandidates(1).first?.string ?? ""
    let confidence = observation.confidence

    // Vision bbox is normalized (0-1), origin bottom-left.
    // Convert to pixel coords, origin top-left.
    let box = observation.boundingBox
    let x = Int(box.origin.x * Double(imageWidth))
    let y = Int((1.0 - box.origin.y - box.height) * Double(imageHeight))
    let w = Int(box.width * Double(imageWidth))
    let h = Int(box.height * Double(imageHeight))

    observations.append(TextObservation(
        text: text,
        confidence: confidence,
        bbox: BBox(x: x, y: y, w: w, h: h)
    ))
}

let encoder = JSONEncoder()
let jsonData = try encoder.encode(observations)
print(String(data: jsonData, encoding: .utf8)!)
