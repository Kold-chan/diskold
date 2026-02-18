#!/usr/bin/env python3
"""Generates simple Diskold icons for PWA"""
import struct, zlib, base64

def make_png(size):
    # Simple dark blue square with "D" letter - minimal PNG
    img = []
    bg = (10, 10, 12)
    fg = (168, 216, 255)
    
    for y in range(size):
        row = []
        for x in range(size):
            # Simple "D" shape in center
            cx, cy = size//2, size//2
            rx, ry = size*0.28, size*0.38
            # Background
            r, g, b = bg
            # Draw a simple circle/glow
            dist = ((x-cx)**2/(rx**2) + (y-cy)**2/(ry**2))**0.5
            if 0.6 < dist < 1.0:
                blend = 1 - abs(dist - 0.8)/0.2
                r = int(bg[0] + (fg[0]-bg[0]) * blend * 0.8)
                g = int(bg[1] + (fg[1]-bg[1]) * blend * 0.8)
                b = int(bg[2] + (fg[2]-bg[2]) * blend * 0.8)
            row.extend([r, g, b])
        img.append(bytes([0] + row))
    
    def chunk(name, data):
        c = name + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    
    header = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    idat = chunk(b'IDAT', zlib.compress(b''.join(img)))
    iend = chunk(b'IEND', b'')
    return header + ihdr + idat + iend

with open('/home/claude/diskold/public/icon-192.png', 'wb') as f:
    f.write(make_png(192))

with open('/home/claude/diskold/public/icon-512.png', 'wb') as f:
    f.write(make_png(512))

print("Icons generated!")
