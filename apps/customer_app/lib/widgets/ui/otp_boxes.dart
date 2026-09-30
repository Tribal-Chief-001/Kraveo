import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'format.dart';

/// Segmented one-time-code entry. A single hidden text field drives the boxes, so paste,
/// SMS autofill (one-time-code hint), backspace and the numeric keyboard all just work.
/// Bump `errorTick` to shake the boxes and show the error state.
class OtpBoxes extends StatefulWidget {
  const OtpBoxes({
    super.key,
    required this.controller,
    this.length = 4,
    this.autofocus = true,
    this.enabled = true,
    this.hasError = false,
    this.errorTick = 0,
    this.boxHeight = 68,
    this.onChanged,
    this.onCompleted,
    this.focusNode,
  });

  final TextEditingController controller;
  final int length;
  final bool autofocus;
  final bool enabled;
  final bool hasError;
  final int errorTick;
  final double boxHeight;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onCompleted;
  final FocusNode? focusNode;

  @override
  State<OtpBoxes> createState() => _OtpBoxesState();
}

class _OtpBoxesState extends State<OtpBoxes> with SingleTickerProviderStateMixin {
  late final FocusNode _focus = widget.focusNode ?? FocusNode();
  late final AnimationController _shake = AnimationController(vsync: this, duration: const Duration(milliseconds: 420));

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_rebuild);
    _focus.addListener(_rebuild);
  }

  @override
  void didUpdateWidget(covariant OtpBoxes old) {
    super.didUpdateWidget(old);
    if (old.errorTick != widget.errorTick) {
      _shake.forward(from: 0);
      HapticFeedback.heavyImpact();
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_rebuild);
    _focus.removeListener(_rebuild);
    if (widget.focusNode == null) _focus.dispose();
    _shake.dispose();
    super.dispose();
  }

  void _rebuild() {
    if (mounted) setState(() {});
  }

  void _handleChanged(String value) {
    widget.onChanged?.call(value);
    if (value.length == widget.length) widget.onCompleted?.call(value);
  }

  @override
  Widget build(BuildContext context) {
    final text = widget.controller.text;
    final focused = _focus.hasFocus && widget.enabled;
    final activeIndex = math.min(text.length, widget.length - 1);

    return AnimatedBuilder(
      animation: _shake,
      builder: (context, child) => Transform.translate(
        offset: Offset(math.sin(_shake.value * math.pi * 5) * 10 * (1 - _shake.value), 0),
        child: child,
      ),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.enabled
            ? () {
                _focus.requestFocus();
                SystemChannels.textInput.invokeMethod<void>('TextInput.show');
              }
            : null,
        child: Stack(children: [
          Row(children: [
            for (var i = 0; i < widget.length; i++)
              Expanded(
                child: Padding(
                  padding: EdgeInsets.only(left: i == 0 ? 0 : 6, right: i == widget.length - 1 ? 0 : 6),
                  child: _Box(
                    height: widget.boxHeight,
                    char: i < text.length ? text[i] : null,
                    active: focused && i == activeIndex,
                    error: widget.hasError,
                  ),
                ),
              ),
          ]),
          // Hidden input that owns focus, paste, autofill and the keyboard.
          Positioned.fill(
            child: Opacity(
              opacity: 0,
              child: TextField(
                controller: widget.controller,
                focusNode: _focus,
                autofocus: widget.autofocus,
                enabled: widget.enabled,
                keyboardType: TextInputType.number,
                textInputAction: TextInputAction.done,
                autofillHints: const [AutofillHints.oneTimeCode],
                enableInteractiveSelection: false,
                showCursor: false,
                maxLines: 1,
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(widget.length),
                ],
                decoration: const InputDecoration.collapsed(hintText: null),
                onChanged: _handleChanged,
              ),
            ),
          ),
        ]),
      ),
    );
  }
}

class _Box extends StatelessWidget {
  const _Box({required this.height, required this.char, required this.active, required this.error});

  final double height;
  final String? char;
  final bool active;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final filled = char != null;
    final Color border = error ? KraveoPalette.danger : (active ? k.brand : (filled ? k.brand.withValues(alpha: 0.4) : k.line));
    return AnimatedContainer(
      duration: KMotion.fast,
      curve: KMotion.emphasized,
      height: height,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: error ? KraveoPalette.danger.withValues(alpha: 0.06) : (filled ? k.brandSoft : k.surface),
        borderRadius: BorderRadius.circular(KRadius.lg),
        border: Border.all(color: border, width: active || error ? 2.2 : 1.4),
        boxShadow: active ? KShadow.glow(k.brand).map((s) => s.copyWith(color: s.color.withValues(alpha: 0.14))).toList() : null,
      ),
      child: AnimatedSwitcher(
        duration: KMotion.fast,
        transitionBuilder: (child, anim) => ScaleTransition(scale: CurvedAnimation(parent: anim, curve: KMotion.spring), child: FadeTransition(opacity: anim, child: child)),
        child: filled
            ? Text(char!, key: ValueKey(char), style: KraveoType.numeric.copyWith(color: error ? kDangerInk : k.ink, fontSize: 30))
            : (active
                ? Container(key: const ValueKey('caret'), width: 2, height: 26, decoration: BoxDecoration(color: k.brand, borderRadius: BorderRadius.circular(2)))
                : const SizedBox.shrink(key: ValueKey('empty'))),
      ),
    );
  }
}
