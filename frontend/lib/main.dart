import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Fullstack Monorepo',
      // Clean, dark aesthetic matching corporate developer tooling
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF121212),
        primaryColor: Colors.deepPurple,
      ),
      home: const ApiStatusScreen(),
    );
  }
}

class ApiStatusScreen extends StatefulWidget {
  const ApiStatusScreen({super.key});

  @override
  State<ApiStatusScreen> createState() => _ApiStatusScreenState();
}

class _ApiStatusScreenState extends State<ApiStatusScreen> {
  String _message = "Press the button to fetch data";
  String _status = "Unknown";
  String _timestamp = "N/A";
  bool _isLoading = false;

  // Environment Detection:
  // Points to local Node.js port during local development (kDebugMode).
  // Uses relative roots when hosted together live under a Vercel domain.
  final String _apiUrl = kDebugMode ? 'http://localhost:3000/api' : '/api';

  Future<void> _fetchApiData() async {
    setState(() {
      _isLoading = true;
    });

    try {
      final response = await http.get(Uri.parse(_apiUrl));

      if (response.statusCode == 200) {
        // Parse the JSON string into a Dart Map
        final Map<String, dynamic> data = jsonDecode(response.body);

        setState(() {
          _message = data['message'] ?? 'No message found';
          _status = data['status'] ?? 'No status found';
          _timestamp = data['timestamp'] ?? 'No timestamp found';
        });
      } else {
        setState(() {
          _message = "Server responded with error code: ${response.statusCode}";
        });
      }
    } catch (e) {
      setState(() {
        _message =
            "Failed to connect to the Node server. Is it running? Error: $e";
      });
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('TradeLab - Workspace Test'),
        backgroundColor: const Color(0xFF1F1F1F),
        elevation: 0,
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Container(
            constraints: const BoxConstraints(maxWidth: 500),
            padding: const EdgeInsets.all(24.0),
            decoration: BoxDecoration(
              color: const Color(0xFF1E1E1E),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.white12),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'API Endpoint Monitor',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Target URL: $_apiUrl',
                  style: const TextStyle(
                    color: Colors.grey,
                    fontSize: 12,
                    fontFamily: 'monospace',
                  ),
                ),
                const Divider(height: 32, color: Colors.white12),
                if (_isLoading)
                  const Center(
                    child: Padding(
                      padding: EdgeInsets.symmetric(vertical: 20.0),
                      child: CircularProgressIndicator(
                        color: Colors.deepPurpleAccent,
                      ),
                    ),
                  )
                else ...[
                  _buildDataRow('Message:', _message),
                  const SizedBox(height: 12),
                  _buildDataRow('Status:', _status, isStatus: true),
                  const SizedBox(height: 12),
                  _buildDataRow('Timestamp:', _timestamp),
                ],
                const Divider(height: 32, color: Colors.white12),
                SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: ElevatedButton(
                    onPressed: _isLoading ? null : _fetchApiData,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.deepPurpleAccent,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                    child: const Text('Fetch Server Data'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildDataRow(String label, String value, {bool isStatus = false}) {
    Color valueColor = Colors.white70;
    if (isStatus && value == 'online') valueColor = Colors.greenAccent;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            color: Colors.grey,
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          value,
          style: TextStyle(color: valueColor, fontSize: 15, height: 1.4),
        ),
      ],
    );
  }
}
